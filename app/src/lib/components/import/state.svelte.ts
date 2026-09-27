// What the import windows show: the "Import from a link" window (optionally with a link already in it)
// and the "Add to…" window for dropped model files. Opened from the palette, the top bar, a paste or a
// drop; the windows live in the global overlays.
class ImportWindows {
	/** The link window: null when closed, otherwise the link to start with ('' for none). */
	link = $state<string | null>(null);
	/** Dropped STL/3MF/OBJ files waiting for "Add to…". */
	files = $state<File[] | null>(null);

	openLink(url = '') {
		this.files = null;
		this.link = url;
	}
	addFiles(files: File[]) {
		this.link = null;
		this.files = files;
	}
	close() {
		this.link = null;
		this.files = null;
	}
}

export const importWindows = new ImportWindows();
