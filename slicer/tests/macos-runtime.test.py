#!/usr/bin/env python3
"""Portable Mach-O fixtures exercise relocation planning; macOS CI runs the actual Apple tools."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

script = Path(__file__).resolve().parents[1] / 'scripts' / 'bundle-macos-runtime.py'
spec = importlib.util.spec_from_file_location('macos_runtime', script)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def binary(dependencies=(), rpaths=(), identities=()):
    commands = []
    for kind, values in ((0xc, dependencies), (0x8000001c, rpaths), (0xd, identities)):
        for value in values:
            prefix = 12 if kind == 0x8000001c else 24
            text = value.encode('utf-8') + b'\0'
            size = (prefix + len(text) + 7) // 8 * 8
            command = struct.pack('<III', kind, size, prefix) + bytes(prefix - 12) + text
            commands.append(command.ljust(size, b'\0'))
    body = b''.join(commands)
    return struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, len(commands), len(body), 0, 0) + body


class MacRuntime(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='printlab-é-印刷-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.engine = self.root / 'build tree' / 'printlab-slicer'
        self.bundle = self.root / 'installed é 印刷'
        self.bundle.mkdir()
        self.commands = []

    def write(self, path, *args, **kwargs):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(binary(*args, **kwargs))
        return path

    def tools(self, command):
        self.commands.append(command)
        if command[0] != 'install_name_tool':
            return
        file = Path(command[-1])
        deps, rpaths, ids = runtime.macho(file)
        at = 1
        while at < len(command) - 1:
            flag = command[at]
            if flag == '-change':
                deps = [command[at + 2] if d == command[at + 1] else d for d in deps]
                at += 3
            elif flag == '-delete_rpath':
                rpaths.remove(command[at + 1])
                at += 2
            elif flag == '-id':
                ids = [command[at + 1]]
                at += 2
            else:
                self.fail(f'Unexpected edit: {command}')
        file.write_bytes(binary(deps, rpaths, ids))

    def test_closes_transitive_aliases_cycles_rpaths_and_signs_after_editing(self):
        actual = self.root / 'Cellar/zstd/lib/libzstd.1.5.dylib'
        alias = actual.parent / 'libzstd.1.dylib'
        helper = self.root / 'Homebrew extras/libhelper.dylib'
        self.write(actual, ['@rpath/libhelper.dylib', '/usr/lib/libSystem.B.dylib'],
                   [str(helper.parent)], [str(actual)])
        (actual.parent.parent / 'LICENSE').write_text('Zstandard bottle licence fixture')
        actual.chmod(0o444)  # Homebrew bottles may install read-only libraries.
        alias.symlink_to(actual.name)
        self.write(helper, [str(alias)], ['/opt/homebrew/lib'], [str(helper)])
        self.write(self.engine, [str(alias), str(actual)], ['/opt/homebrew/lib'])
        runtime.bundle(self.engine, self.bundle, self.tools)
        self.assertEqual({p.name for p in runtime.audit(self.bundle)},
                         {'printlab-slicer', actual.name, helper.name})
        self.assertEqual((self.bundle / 'licenses/zstd-BSD.txt').read_text(), 'Zstandard bottle licence fixture')
        for file in (p for p in self.bundle.iterdir() if p.is_file()):
            deps, rpaths, ids = runtime.macho(file)
            self.assertFalse(rpaths)
            self.assertTrue(all(d.startswith('@loader_path/') or runtime.system(d) for d in deps))
            self.assertTrue(all(i.startswith('@loader_path/') for i in ids))
        first_sign = next(i for i, c in enumerate(self.commands) if c[0] == 'codesign')
        self.assertTrue(all(c[0] == 'install_name_tool' for c in self.commands[:first_sign]))
        self.assertTrue(all(c[0] == 'codesign' for c in self.commands[first_sign:]))
        self.assertEqual(self.commands[-1], ['codesign', '--verify', '--strict', str(self.bundle / 'printlab-slicer')])
        self.assertIn(str(alias), runtime.macho(self.engine)[0])  # build output is untouched

    def test_resolves_loader_executable_and_inherited_rpath(self):
        lib = self.write(self.engine.parent / 'lib/libone.dylib', ['@rpath/libtwo.dylib'])
        second = self.write(self.engine.parent / 'other/libtwo.dylib', ['@executable_path/lib/libone.dylib'])
        self.write(self.engine, ['@loader_path/lib/libone.dylib'], ['@executable_path/other'])
        runtime.bundle(self.engine, self.bundle, self.tools)
        self.assertEqual({p.name for p in runtime.audit(self.bundle)}, {'printlab-slicer', lib.name, second.name})

    def test_rejects_distinct_libraries_with_the_same_basename(self):
        a = self.write(self.root / 'a/libsame.dylib')
        b = self.write(self.root / 'b/libsame.dylib')
        self.write(self.engine, [str(a), str(b)])
        with self.assertRaisesRegex(ValueError, 'basename collision'):
            runtime.bundle(self.engine, self.bundle, self.tools)

    def test_missing_non_system_library_is_fatal(self):
        self.write(self.engine, ['/opt/homebrew/missing/libfoo.dylib'])
        with self.assertRaisesRegex(ValueError, 'Unresolved runtime dependency'):
            runtime.bundle(self.engine, self.bundle, self.tools)

    def test_zstd_notice_fallback_and_no_dependency_copy_outside_destination(self):
        library = self.write(self.root / 'outside/libzstd.1.5.7.dylib')
        original = library.read_bytes()
        self.write(self.engine, [str(library)])
        runtime.bundle(self.engine, self.bundle, self.tools)
        notice = (self.bundle / 'licenses/zstd-BSD.txt').read_text()
        self.assertIn('Copyright (c) Meta Platforms', notice)
        self.assertIn('Redistribution and use in source and binary forms', notice)
        self.assertEqual(library.read_bytes(), original)
        self.assertTrue(all(Path(c[-1]).is_relative_to(self.bundle) for c in self.commands))

    def test_external_dependencies_and_rpaths_fail_even_when_host_library_exists(self):
        host = self.write(self.root / 'homebrew/libhost.dylib')
        self.write(self.bundle / 'printlab-slicer', [str(host)])
        with self.assertRaisesRegex(ValueError, 'External dependency'):
            runtime.audit(self.bundle)
        self.write(self.bundle / 'printlab-slicer', ['/usr/lib/libSystem.B.dylib'], [str(host.parent)])
        with self.assertRaisesRegex(ValueError, 'External runtime path'):
            runtime.audit(self.bundle)

    def test_audits_copied_libraries_and_blocks_parent_and_symlink_escape(self):
        engine = self.bundle / 'printlab-slicer'
        host = self.write(self.root / 'libhost.dylib')
        self.write(engine, ['@loader_path/../libhost.dylib'])
        with self.assertRaisesRegex(ValueError, 'escapes bundle'):
            runtime.audit(self.bundle)
        (self.bundle / host.name).symlink_to(host)
        self.write(engine, ['@executable_path/libhost.dylib'])
        with self.assertRaisesRegex(ValueError, 'escapes bundle'):
            runtime.audit(self.bundle)
        (self.bundle / host.name).unlink()
        self.write(self.bundle / host.name, ['/opt/homebrew/lib/libzstd.1.dylib'])
        with self.assertRaisesRegex(ValueError, 'External dependency'):
            runtime.audit(self.bundle)

    def test_universal_binary_checks_every_slice(self):
        good = binary(['/usr/lib/libSystem.B.dylib'])
        bad = binary(['/opt/homebrew/lib/libzstd.1.dylib'])
        offset = 8 + 2 * 20
        header = struct.pack('>II', 0xcafebabe, 2)
        header += struct.pack('>IIIII', 0x100000c, 0, offset, len(good), 0)
        header += struct.pack('>IIIII', 0x1000007, 0, offset + len(good), len(bad), 0)
        (self.bundle / 'printlab-slicer').write_bytes(header + good + bad)
        with self.assertRaisesRegex(ValueError, 'External dependency'):
            runtime.audit(self.bundle)

    def test_rejects_malformed_load_command_and_missing_bundle_library(self):
        file = self.bundle / 'printlab-slicer'
        file.write_bytes(struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 8, 0, 0) + struct.pack('<II', 0xc, 100))
        with self.assertRaisesRegex(ValueError, 'command size'):
            runtime.audit(self.bundle)
        self.write(file, ['@loader_path/missing.dylib'])
        with self.assertRaises(FileNotFoundError):
            runtime.audit(self.bundle)


if __name__ == '__main__':
    unittest.main()
