#!/usr/bin/env python3
"""Bundle non-system Mach-O dependencies; audit without needing macOS or its toolchain."""
import argparse
from pathlib import Path
import shutil
import stat
import struct
import subprocess


def macho(path):
    data = Path(path).read_bytes()
    dependencies, rpaths, identities = [], [], []

    def read(offset, limit):
        magic = data[offset:offset + 4]
        fat = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
               b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}
        if magic in fat:
            endian, wide = fat[magic]
            count = struct.unpack_from(endian + 'I', data, offset + 4)[0]
            if not 0 < count <= 32:
                raise ValueError(f'Invalid universal Mach-O: {path}')
            size = 32 if wide else 20
            for index in range(count):
                entry = offset + 8 + index * size
                start, length = struct.unpack_from(endian + ('QQ' if wide else 'II'), data, entry + 8)
                if start < 8 + count * size or offset + start + length > limit:
                    raise ValueError(f'Invalid Mach-O slice: {path}')
                read(offset + start, offset + start + length)
            return
        formats = {b'\xcf\xfa\xed\xfe': ('<', 32), b'\xfe\xed\xfa\xcf': ('>', 32),
                   b'\xce\xfa\xed\xfe': ('<', 28), b'\xfe\xed\xfa\xce': ('>', 28)}
        if magic not in formats:
            raise ValueError(f'Not a Mach-O binary: {path}')
        endian, header = formats[magic]
        count, total = struct.unpack_from(endian + 'II', data, offset + 16)
        position, end = offset + header, offset + header + total
        if end > limit or count > total // 8:
            raise ValueError(f'Invalid Mach-O commands: {path}')
        for _ in range(count):
            command, size = struct.unpack_from(endian + 'II', data, position)
            if size < 8 or position + size > end:
                raise ValueError(f'Invalid Mach-O command size: {path}')
            target = (dependencies if command in (0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023)
                      else identities if command == 0xd else rpaths if command == 0x8000001c else None)
            if target is not None:
                relative = struct.unpack_from(endian + 'I', data, position + 8)[0]
                if not 12 <= relative < size:
                    raise ValueError(f'Invalid Mach-O string: {path}')
                value = data[position + relative:position + size].split(b'\0', 1)[0].decode('utf-8')
                if value not in target:
                    target.append(value)
            position += size
        if position != end:
            raise ValueError(f'Incomplete Mach-O commands: {path}')

    read(0, len(data))
    return dependencies, rpaths, identities


def system(reference):
    normal = str(Path(reference))
    return '..' not in Path(reference).parts and normal.startswith(('/usr/lib/', '/System/Library/'))


def expand(reference, owner, executable):
    for prefix, directory in (('@loader_path/', owner.parent), ('@executable_path/', executable.parent)):
        if reference.startswith(prefix):
            return directory / reference[len(prefix):]
    if reference in ('@loader_path', '@executable_path'):
        return owner.parent if reference == '@loader_path' else executable.parent
    if reference.startswith('/'):
        return Path(reference)
    raise ValueError(f'Unsupported runtime path {reference} in {owner}')


def inside(path, root):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError(f'Runtime dependency escapes bundle: {path}')
    return resolved


def audit(directory):
    root = Path(directory).resolve(strict=True)
    executable = root / 'printlab-slicer'
    visited = set()

    def visit(binary):
        binary = inside(binary, root)
        if binary in visited:
            return
        visited.add(binary)
        dependencies, rpaths, identities = macho(binary)
        for reference in rpaths + identities:
            if not reference.startswith(('@loader_path/', '@executable_path/')) and reference not in ('@loader_path', '@executable_path'):
                raise ValueError(f'External runtime path in {binary}: {reference}')
            inside(expand(reference, binary, executable), root)
        for reference in dependencies:
            if system(reference):
                continue
            if not reference.startswith(('@loader_path/', '@executable_path/')):
                raise ValueError(f'External dependency in {binary}: {reference}')
            visit(expand(reference, binary, executable))

    visit(executable)
    return visited


def bundle(engine, destination, run=subprocess.check_call):
    engine = Path(engine).resolve(strict=True)
    destination = Path(destination).resolve(strict=True)
    target = destination / engine.name
    if engine == target:
        raise ValueError('Bundle destination must differ from the build tree')
    shutil.copy2(engine, target)
    target.chmod(target.stat().st_mode | stat.S_IWUSR)
    copied = {engine: target}
    names = {target.name: engine}
    pending = [(engine, target, [])]
    while pending:
        source, output, inherited = pending.pop(0)
        dependencies, rpaths, identities = macho(source)
        search = [expand(r, source, engine) for r in rpaths] + inherited
        edits = []
        for reference in dependencies:
            if system(reference):
                continue
            candidates = ([directory / reference[len('@rpath/'):] for directory in search]
                          if reference.startswith('@rpath/') else [expand(reference, source, engine)])
            resolved = next((p.resolve() for p in candidates if p.is_file()), None)
            if resolved is None:
                raise ValueError(f'Unresolved runtime dependency {reference} in {source}')
            if any(part.endswith('.framework') for part in resolved.parts):
                raise ValueError(f'Non-system frameworks require a complete framework bundle: {resolved}')
            name = resolved.name
            if name in names and names[name] != resolved:
                raise ValueError(f'Dylib basename collision: {resolved} and {names[name]}')
            names[name] = resolved
            if resolved not in copied:
                library = destination / name
                shutil.copy2(resolved, library)
                library.chmod(library.stat().st_mode | stat.S_IWUSR)
                copied[resolved] = library
                pending.append((resolved, library, search))
            edits.extend(['-change', reference, f'@loader_path/{name}'])
        for rpath in rpaths:
            edits.extend(['-delete_rpath', rpath])
        if identities:
            edits.extend(['-id', f'@loader_path/{output.name}'])
        if edits:
            run(['install_name_tool', *edits, str(output)])
    # Load-command edits invalidate signatures. Sign every library before the executable.
    for binary in [p for p in copied.values() if p != target] + [target]:
        run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(binary)])
        run(['codesign', '--verify', '--strict', str(binary)])
    for source in copied:
        if source.name.startswith('libzstd.'):
            # Prefer the bottle's own notice. BSD fallback is the upstream v1.5.7 LICENSE:
            # https://github.com/facebook/zstd/blob/v1.5.7/LICENSE
            candidates = [source.parent.parent / 'LICENSE',
                          source.parent.parent / 'share/doc/zstd/LICENSE',
                          Path(__file__).resolve().parents[1] / 'licenses/zstd-BSD.txt']
            notice = next(p for p in candidates if p.is_file())
            notices = destination / 'licenses'
            notices.mkdir(exist_ok=True)
            shutil.copyfile(notice, notices / 'zstd-BSD.txt')
    audit(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine')
    parser.add_argument('--destination')
    parser.add_argument('--audit')
    args = parser.parse_args()
    if args.audit:
        audit(args.audit)
    elif args.engine and args.destination:
        bundle(args.engine, args.destination)
    else:
        parser.error('Use --audit DIR or --engine FILE --destination DIR')
