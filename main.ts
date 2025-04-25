import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	TFile,
	ViewState,
	EditorPosition,
	EditorSelection,
	TFolder,
	normalizePath,
	debounce,
	MarkdownPostProcessorContext,
	TAbstractFile,
	SplitDirection,
    MarkdownFileInfo,
	// setIcon, // 必要ならコメント解除
} from 'obsidian';

// --- Utility Functions ---
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// --- Interfaces ---

/** プラグインのユーザー設定可能な設定 */
interface CornellPluginSettings {
	// From main.ts その1
	cuePrefix: string;
	lastMode: 'capture' | 'recall' | 'review' | 'show-all' | null; // 'show-all' を追加（または別の方法で管理）
	lastFile: string | null; // Path of the SOURCE note
	paneWidthRatio: { left: number, center: number, right: number };
	enforceCuePreview: boolean; // Keep Cue pane in Preview mode

	// From main.ts その2
	syncOnSave: boolean; // 保存時に自動同期するか
	deleteReferencesOnDefinitionDelete: boolean; // C->S同期時: Cueで定義削除されたらSourceの参照も削除するか
    deleteDefinitionsOnReferenceDelete: boolean; // S->C同期時: Sourceで全参照削除されたらCueの定義も削除するか
	linkToSourceText: string; // Cue/Summaryノートに挿入するSourceノートへのリンクテキスト
	linkToCueText: string; // Summaryノートに挿入するCueノートへのリンクテキスト
	enableCueNoteNavigation: boolean; // コードブロックボタン: クリックでSource参照へナビゲート
    enableModifierClickHighlight: boolean; // コードブロックボタン: Ctrl/Cmd+クリックでSource参照をハイライト
    moveFootnotesToEnd: boolean; // Cue -> Source 同期時にSourceノートの脚注定義を末尾に移動するか
}

/** 保存するノート関連情報 */
interface CornellNoteInfo {
    sourcePath: string; // Sourceノートのパス
    cuePath: string | null; // 対応するCueノートのパス (存在しない場合はnull)
    summaryPath: string | null; // 対応するSummaryノートのパス (存在しない場合はnull)
    lastSyncSourceToCue: number | null; // Source->Cueの最終同期時刻 (Unixタイムスタンプ)
    lastSyncCueToSource: number | null; // Cue->Sourceの最終同期時刻 (Unixタイムスタンプ)
}

/** DebouncedFunction インターフェース */
interface DebouncedFunction<TArgs extends any[]> {
    (...args: TArgs): void;
    cancel(): void;
}

/** 位置情報インターフェース */
interface Position {
	start: number; // 文字列内の開始位置
	end: number; // 文字列内の終了位置
}

/** 解析された脚注定義の情報 */
interface ParsedDefinition extends Position {
	ref: string; // 参照名 (例: "1", "abc")
	definition: string; // 定義内容 (例: "This is a note.")
	fullMatch: string; // 正規表現にマッチした文字列全体 (例: "[^1]: This is a note.")
}

/** 解析された脚注参照の情報 */
interface ParsedReference extends Position {
	ref: string; // 参照名 (例: "1", "abc")
	fullMatch: string; // 正規表現にマッチした文字列全体 (例: "[^1]")
}


// --- Constants ---

/** プラグインのデフォルト設定 */
const DEFAULT_SETTINGS: Required<CornellPluginSettings> = {
	// From main.ts その1
	cuePrefix: 'cue',
	lastMode: null,
	lastFile: null,
	paneWidthRatio: { left: 25, center: 50, right: 25 }, // Show All モードでは均等割り (33:34:33) に変更するかも？
	enforceCuePreview: true,
	// From main.ts その2
	syncOnSave: false,
	deleteReferencesOnDefinitionDelete: false,
    deleteDefinitionsOnReferenceDelete: false,
	linkToSourceText: '[[{{sourceNote}}|⬅️ Back to Source]]',
	linkToCueText: '[[{{cueNote}}|⬅️ Back to Cue]]',
	enableCueNoteNavigation: true,
    enableModifierClickHighlight: true,
    moveFootnotesToEnd: true,
};

/** 内部定数 */
const INTERNAL_SETTINGS = {
	cueNoteSuffix: '-cue',
	summaryNoteSuffix: '-summary',
	syncDebounceTime: 1500,
	batchSyncUpdateInterval: 50,
	uiUpdateDelay: 250,
	syncFlagReleaseDelay: 100,
    highlightDuration: 1500,
    codeBlockProcessorId: 'cornell-footnote-links',
};

// CSS Class for Cornell Panes
const CORNELL_PANE_CLASS = 'cornell-pane';
const CORNELL_LEFT_PANE_CLASS = 'cornell-pane-left'; // Cue Pane
const CORNELL_CENTER_PANE_CLASS = 'cornell-pane-center'; // Source Pane
const CORNELL_RIGHT_PANE_CLASS = 'cornell-pane-right'; // Summary Pane

// Leaf Position Type
type LeafPosition = 'left' | 'center' | 'right';

// Cornell Mode Type
type CornellMode = 'capture' | 'recall' | 'review' | 'show-all';

// --- Main Plugin Class ---
export default class CornellPlugin extends Plugin {
	settings: CornellPluginSettings;
	private isSwitchingMode: boolean = false;
    // Track leaf OBJECTS directly for the current Cornell view
	activeCornellLeaves: {
		left: WorkspaceLeaf | null, // Cue
		center: WorkspaceLeaf | null, // Source
		right: WorkspaceLeaf | null // Summary
	} = { left: null, center: null, right: null };
    // The SOURCE file currently active in the Cornell view
    private activeSourceFileForCornell: TFile | null = null;

    // Public accessor for checking if a Cornell mode is active
    public hasActiveSourceFile(): boolean {
        return this.activeSourceFileForCornell !== null;
    }
	private isEnforcingPreview: boolean = false; // Flag to prevent recursion for enforceCuePreview

    // From main.ts その2
	private debouncedSyncSourceToCue!: DebouncedFunction<[TFile]>;
	private debouncedSyncCueToSource!: DebouncedFunction<[TFile]>;
    private isSyncing: boolean = false;
    private noteInfoMap: Map<string, CornellNoteInfo> = new Map();
    private activeHighlightTimeout: NodeJS.Timeout | null = null;


	async onload() {
		console.log("Cornell Plugin: Loading Combined Plugin...");
		await this.loadSettingsAndNoteInfo();
		await this.initializeOrUpdateNoteInfoMap();

        // Initialize Debounce functions
		this.debouncedSyncSourceToCue = debounce( this.syncSourceToCue, INTERNAL_SETTINGS.syncDebounceTime, true ) as DebouncedFunction<[TFile]>;
		this.debouncedSyncCueToSource = debounce( this.syncCueToSource, INTERNAL_SETTINGS.syncDebounceTime, true ) as DebouncedFunction<[TFile]>;

		// --- Register Commands ---
		this.addCommand({
			id: 'cornell-capture-mode',
			name: 'Cornell: Activate Capture Mode (Cue + Source)',
			hotkeys: [{ modifiers: ["Alt"], key: "1" }],
			callback: () => this.activateMode('capture')
		});
		this.addCommand({
			id: 'cornell-recall-mode',
			name: 'Cornell: Activate Recall Mode (Cue + Summary)',
			hotkeys: [{ modifiers: ["Alt"], key: "2" }],
			callback: () => this.activateMode('recall')
		});
		this.addCommand({
			id: 'cornell-review-mode',
			name: 'Cornell: Activate Review Mode (Source + Summary)',
			hotkeys: [{ modifiers: ["Alt"], key: "3" }],
			callback: () => this.activateMode('review')
		});
        // NEW: Show All Mode Command
		this.addCommand({
			id: 'cornell-show-all-mode',
			name: 'Cornell: Activate Show All Mode (Cue + Source + Summary)',
			hotkeys: [{ modifiers: ["Alt"], key: "4" }],
			callback: () => this.activateMode('show-all') // Reuse activateMode with new type
		});
		this.addCommand({
			id: 'cornell-generate-cue',
			name: 'Cornell: Generate Cue from Selection (adds to Cue note)',
			hotkeys: [{ modifiers: ["Alt"], key: "c" }],
			editorCallback: (editor: Editor, view: MarkdownView) => {
                // This command should only work when the Source pane (center) is active
				if (view.file && this.isSourceNote(view.file.path)) {
                    // Check if it's the center pane in an active Cornell setup
                    let isCenterPane = false;
                    if (this.activeCornellLeaves.center && this.activeCornellLeaves.center.view === view) {
                        isCenterPane = true;
                    }
                    // Allow even if not in Cornell mode, as long as it's a source note
					this.generateCue(editor, view);
				} else {
					new Notice("Cue generation works on the Source note. Activate the Source pane (usually center) or open the Source note.");
				}
			}
		});

        // Commands from main.ts その2
        this.addCommand({
			id: 'sync-source-to-cue-manually',
			name: 'Cornell: Manual Sync: Source -> Cue',
			editorCallback: (editor: Editor, view: MarkdownView) => this.manualSyncHandler(view, 'S->C')
		});
        this.addCommand({
            id: 'sync-cue-to-source-manually',
            name: 'Cornell: Manual Sync: Cue -> Source',
            editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => this.manualSyncHandler(view, 'C->S', checking)
        });
		this.addCommand({
			id: 'sync-all-notes-source-to-cue',
			name: 'Cornell: Sync All Notes (Source -> Cue)',
			callback: async () => {
				new Notice('Starting full sync (S->C) for all notes...', 3000);
				await this.processAllNotesSourceToCue()
				  .catch(err => { console.error('Error during full sync (S->C):', err); new Notice('Full sync (S->C) failed. See console.'); });
			},
		});
		this.addCommand({
			id: 'arrange-cornell-notes',
			name: 'Cornell: Arrange Cornell Notes View',
			editorCallback: (editor: Editor, view: MarkdownView) => {
                const file = view.file;
				if (file && this.isSourceNote(file.path)) {
                    // Run from Source note
					this.arrangeCornellNotesView(file, view.leaf)
						.then(() => new Notice(`Arranged view for ${file.basename}. Cue/Summary notes created/opened if needed.`))
						.catch(err => {
							console.error(`Error arranging view for ${file.path}:`, err);
							new Notice('Error arranging view. See console.');
						});
				} else if (file) {
					new Notice('Run "Arrange Cornell Notes View" from the main Source note.');
				} else {
					new Notice('No active file to arrange view for.');
				}
            },
		});
		this.addCommand({
			id: 'highlight-first-source-reference',
			name: 'Cornell: Highlight First Reference in Source (from Cue def/button)',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
                if (view.file && this.isCueNote(view.file.path)) {
					if (!checking) {
						const cursor = editor.getCursor();
						const currentLine = editor.getLine(cursor.line);
						const defMatch = currentLine.match(/^\s*\[\^([^\]]+?)\]:/);
                        const cbRefMatch = currentLine.match(/^\s*\[\^(\w+?)\]/); // Matches button text
                        const ref = defMatch?.[1]?.trim() || cbRefMatch?.[1]?.trim();
						if (ref) {
							this.highlightFirstSourceReference(ref, view.file.path)
								.catch(err => {
									console.error(`Error highlighting source for ref [${ref}] via command from ${view.file?.path}:`, err);
                                    new Notice(`Error highlighting ref [${ref}]. See console.`);
								});
						} else {
                            new Notice("Place cursor on a footnote definition line ([^ref]:) or a button ([^ref]) in the Cue note.");
						}
					}
					return true;
				}
				return false;
            }
		});

		// FR-04: Restore Layout on Load
		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.lastMode && this.settings.lastFile) {
				const file = this.app.vault.getAbstractFileByPath(this.settings.lastFile);
				if (file instanceof TFile && this.isSourceNote(file.path)) { // Ensure it's a source note
					const modeToRestore = this.settings.lastMode;
					const fileToRestore = file;
					// Clear state immediately to prevent re-triggering
					this.settings.lastMode = null;
					this.settings.lastFile = null;
					await this.saveData(); // Save cleared state

					await sleep(1500); // Wait for workspace stability

					if (!this.isSwitchingMode) {
                        // Only restore 'capture', 'recall', 'review' modes automatically
                        if (modeToRestore !== 'show-all') {
						    try {
                                // Activate mode using the source file
							    await this.activateMode(modeToRestore, fileToRestore, true);
							    console.log(`Cornell Plugin: Restore successful for ${fileToRestore.path} in ${modeToRestore} mode.`);
						    } catch (error) {
							    console.error("Cornell Plugin: Error during restore state activation:", error);
                                // State already cleared
						    }
                        } else {
                            console.log("Cornell Plugin: Skipping restore of 'show-all' mode.");
                        }
					} else {
						console.log("Cornell Plugin: Mode switch already in progress during restore attempt.");
					}
				} else {
					console.log(`Cornell Plugin: Restore cancelled - Source file not found or invalid: ${this.settings.lastFile}`);
					this.settings.lastMode = null;
					this.settings.lastFile = null;
					await this.saveData();
				}
			} else {
				// console.log("Cornell Plugin: No last state to restore.");
			}
		});


		// Add Settings Tab
		this.addSettingTab(new CornellSettingTab(this.app, this));

		// Enforce Cue Preview Mode (From main.ts その1)
		this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf) => {
            // Only enforce if the setting is on, it's the tracked left leaf, and not already enforcing
			if (!this.settings.enforceCuePreview || this.isEnforcingPreview || !leaf || this.activeCornellLeaves.left !== leaf) {
				return;
			}
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() !== 'preview') {
				this.isEnforcingPreview = true;
				// console.log(`Cornell Plugin: Enforcing preview mode for Cue pane.`);
				try {
					await this.setMarkdownViewMode(view, 'preview');
                    await sleep(50); // Give it time to render
				} catch (error) {
					console.error("Error enforcing preview mode:", error);
				} finally {
					setTimeout(() => this.isEnforcingPreview = false, 200); // Prevent rapid re-triggering
				}
			}
		}));

        // Register file modification handler for auto-sync (From main.ts その2)
		this.registerEvent(this.app.vault.on('modify', this.handleFileModifyForAutoSync));

        // Register custom code block processor (From main.ts その2)
        this.registerMarkdownCodeBlockProcessor(
            INTERNAL_SETTINGS.codeBlockProcessorId,
            this.cornellLinksCodeBlockProcessor
        );

		// Save settings when unloading
		this.register(async () => {
			if (!this.isSwitchingMode && !this.isSyncing) { // Avoid saving intermediate state
				await this.saveData();
			}
		});

		console.log("Cornell Plugin: Loaded successfully (Combined).");
	}

	onunload() {
		console.log("Cornell Plugin: Unloading Combined Plugin...");
        // Save state before clearing IF a mode was active
		if (this.settings.lastMode && this.settings.lastFile) {
            // No need to explicitly save here, register(this.saveData) should handle it unless quitting immediately.
		}
		this.clearCornellState(true); // Detach leaves on unload
        this.debouncedSyncSourceToCue?.cancel();
		this.debouncedSyncCueToSource?.cancel();
        if (this.activeHighlightTimeout) { clearTimeout(this.activeHighlightTimeout); this.activeHighlightTimeout = null; }
        console.log("Cornell Plugin: Unloaded.");
	}

	// --- Data Loading/Saving (Combined) ---
    async loadSettingsAndNoteInfo() {
        const savedData = await this.loadData();
        const loadedSettings = savedData?.settings ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // Migrate/Clean old settings if necessary
        ['captureHotkey', 'recallHotkey', 'reviewHotkey', 'generateCueHotkey', 'someOtherOldSetting', 'showReferencesInCue'].forEach(key => {
            if ((this.settings as any)[key] !== undefined) delete (this.settings as any)[key];
        });

        // Type checking for settings (using defaults as fallback)
        for (const key in DEFAULT_SETTINGS) {
            if (typeof this.settings[key as keyof CornellPluginSettings] !== typeof DEFAULT_SETTINGS[key as keyof CornellPluginSettings]) {
                if (key !== 'lastMode' && key !== 'lastFile' && key !== 'paneWidthRatio') { // Allow null/object for these
                     console.warn(`Cornell Setting: Type mismatch for '${key}', reverting to default.`);
                     (this.settings as any)[key] = DEFAULT_SETTINGS[key as keyof CornellPluginSettings];
                }
            }
        }
        // Specific checks for complex types
        if (typeof this.settings.paneWidthRatio !== 'object' || !this.settings.paneWidthRatio || !('left' in this.settings.paneWidthRatio)) {
            this.settings.paneWidthRatio = DEFAULT_SETTINGS.paneWidthRatio;
        }
        // Ensure lastMode is valid or null
        const validModes: Array<CornellMode | null> = ['capture', 'recall', 'review', 'show-all', null];
        if (!validModes.includes(this.settings.lastMode)) {
            this.settings.lastMode = null;
        }


        // Load NoteInfoMap
        this.noteInfoMap = new Map<string, CornellNoteInfo>();
        if (savedData?.noteInfoMap && typeof savedData.noteInfoMap === 'object') {
            try {
                for (const [key, value] of Object.entries(savedData.noteInfoMap)) {
                    if (this.isValidCornellNoteInfo(key, value)) {
                        this.noteInfoMap.set(key, value as CornellNoteInfo);
                    } else {
                        console.warn("Invalid NoteInfo data found during load for key:", key, "Data:", value);
                    }
                }
                console.log(`Cornell Plugin: Loaded ${this.noteInfoMap.size} entries into noteInfoMap.`);
            } catch (e) {
                console.error("Cornell Plugin: Failed to deserialize noteInfoMap:", e);
                this.noteInfoMap = new Map();
            }
        } else {
            console.log("Cornell Plugin: No valid saved noteInfoMap found, initializing empty map.");
        }
    }

    private isValidCornellNoteInfo(key: any, value: any): boolean {
         return typeof key === 'string' &&
               typeof value === 'object' && value !== null &&
               'sourcePath' in value && typeof value.sourcePath === 'string' &&
               'cuePath' in value && (value.cuePath === null || typeof value.cuePath === 'string') &&
               'summaryPath' in value && (value.summaryPath === null || typeof value.summaryPath === 'string') &&
               'lastSyncSourceToCue' in value && (value.lastSyncSourceToCue === null || typeof value.lastSyncSourceToCue === 'number') &&
               'lastSyncCueToSource' in value && (value.lastSyncCueToSource === null || typeof value.lastSyncCueToSource === 'number');
    }

	async saveData() {
        const serializableMap: { [key: string]: CornellNoteInfo } = {};
        for (const [key, value] of this.noteInfoMap.entries()) {
            serializableMap[key] = value;
        }
        // Save both settings and note info map
        await super.saveData({ settings: this.settings, noteInfoMap: serializableMap });
	}

    async saveSettings() { // Primarily for use by the settings tab
        await this.saveData();
    }

	// --- NoteInfoMap Initialization/Update (From main.ts その2) ---
    async initializeOrUpdateNoteInfoMap() {
        console.log("[Cornell Plugin] Initializing or updating Note Info Map...");
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        const currentMapKeys = new Set(this.noteInfoMap.keys());
        let added = 0, updated = 0, removed = 0;
        let mapChanged = false;

        await Promise.all(allMarkdownFiles.map(async file => {
            if (!this.isSourceNote(file.path)) return; // Only process Source notes

            const sourcePath = file.path;
            const expectedCuePath = this.getCueNotePath(file);
            const expectedSummaryPath = this.getSummaryNotePath(file);

            const cueFile = this.app.vault.getAbstractFileByPath(expectedCuePath);
            const summaryFile = this.app.vault.getAbstractFileByPath(expectedSummaryPath);
            const actualCuePath = cueFile instanceof TFile ? cueFile.path : null;
            const actualSummaryPath = summaryFile instanceof TFile ? summaryFile.path : null;

            const currentInfo = this.noteInfoMap.get(sourcePath);
            if (currentInfo) {
                let infoNeedsUpdate = false;
                if (currentInfo.cuePath !== actualCuePath) {
                    currentInfo.cuePath = actualCuePath;
                    infoNeedsUpdate = true;
                }
                if (currentInfo.summaryPath !== actualSummaryPath) {
                    currentInfo.summaryPath = actualSummaryPath;
                    infoNeedsUpdate = true;
                }
                if (infoNeedsUpdate) {
                    updated++;
                    this.noteInfoMap.set(sourcePath, currentInfo);
                    mapChanged = true;
                }
                currentMapKeys.delete(sourcePath);
            } else {
                const newInfo: CornellNoteInfo = {
                    sourcePath,
                    cuePath: actualCuePath,
                    summaryPath: actualSummaryPath,
                    lastSyncSourceToCue: null,
                    lastSyncCueToSource: null
                };
                this.noteInfoMap.set(sourcePath, newInfo);
                added++;
                mapChanged = true;
            }
        }));

        for (const deletedSourcePath of currentMapKeys) {
            if (this.noteInfoMap.delete(deletedSourcePath)) {
                removed++;
                mapChanged = true;
            }
        }

        console.log(`[Cornell Plugin] Note Info Map update: Added ${added}, Updated ${updated}, Removed ${removed}. Total: ${this.noteInfoMap.size}`);
        if (mapChanged) {
            await this.saveData();
            console.log("[Cornell Plugin] NoteInfoMap saved.");
        }
    }

	// --- Event Handlers (Combined) ---
	private handleFileModifyForAutoSync = (file: TAbstractFile) => {
		if (!this.settings.syncOnSave || this.isSyncing || this.isSwitchingMode) return;

		if (file instanceof TFile && file.extension === 'md') {
			if (this.isSourceNote(file.path)) {
                // Source note modified -> Schedule S->C sync
                console.log(`[Auto Sync] Detected modification in Source: ${file.path}. Scheduling S->C sync.`);
                this.debouncedSyncSourceToCue(file);
			} else if (this.isCueNote(file.path)) {
                // Cue note modified -> Schedule C->S sync
                console.log(`[Auto Sync] Detected modification in Cue: ${file.path}. Scheduling C->S sync.`);
                this.debouncedSyncCueToSource(file);
			}
            // Summary note changes do not trigger sync
		}
	};

    // --- Manual Sync Handler (From main.ts その2) ---
	private manualSyncHandler(view: MarkdownView, direction: 'S->C' | 'C->S', checking?: boolean): boolean | void {
		const file = view.file;
		if (!file) {
			if (!checking) new Notice('No active file.');
			return false;
		}

		if (direction === 'S->C') {
            // S->C sync runs from Source note
			if (!this.isSourceNote(file.path)) {
				if (!checking) new Notice('Run S->C sync from the Source note.');
				return false;
			}
			if (!checking) {
				new Notice(`Manual Sync: S->C starting for ${file.basename}...`);
				this.syncSourceToCue(file)
					.then(() => new Notice(`Manual Sync: Cue updated for ${file.basename}.`))
					.catch(err => {
						console.error(`Manual Sync Error (S->C): ${file.path}`, err);
						new Notice('Sync Error (S->C). See console.');
					});
			}
            return true;
		} else if (direction === 'C->S') {
            // C->S sync runs from Cue note
			if (!this.isCueNote(file.path)) {
				if (!checking) new Notice('Run C->S sync from the Cue note.');
				return false;
			}
			if (!checking) {
				new Notice(`Manual Sync: C->S starting from ${file.basename}...`);
				this.syncCueToSource(file)
					.then(() => {
                        const sourceFile = this.getSourceNoteFileFromDerived(file.path);
                        new Notice(`Manual Sync: Source (${sourceFile?.basename ?? 'unknown'}) updated from ${file.basename}.`);
                    })
					.catch(err => {
						console.error(`Manual Sync Error (C->S): ${file.path}`, err);
						new Notice('Sync Error (C->S). See console.');
					});
			}
            return true;
		}
		return false;
	}

	// --- Core Cornell Mode Switching Logic (Combined) ---

	/**
	 * Main function to activate a Cornell mode (Capture, Recall, Review, Show All).
	 * @param mode The Cornell mode to activate.
	 * @param targetSourceFile The specific SOURCE file to use. If null, uses the active file.
	 * @param isRestore Whether this activation is part of restoring the layout on load.
	 */
	async activateMode(mode: CornellMode, targetSourceFile?: TFile, isRestore: boolean = false): Promise<void> {
		if (this.isSwitchingMode || this.isSyncing) {
			console.warn(`Cornell Plugin: Mode switch (${mode}) aborted, another operation in progress (Switching: ${this.isSwitchingMode}, Syncing: ${this.isSyncing}).`);
			if (!isRestore) new Notice("Please wait for the current operation to finish.");
			return;
		}
		this.isSwitchingMode = true;
		console.log(`Cornell Plugin: Activating mode ${mode}... (Restore: ${isRestore})`);

		const activeFile = targetSourceFile ?? this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("Please open a note file first.");
			this.isSwitchingMode = false;
			return;
		}

        // Ensure we are operating on a SOURCE note
        const sourceFile = this.isSourceNote(activeFile.path)
            ? activeFile
            : this.getSourceNoteFileFromDerived(activeFile.path);

        if (!sourceFile) {
            new Notice("Could not determine the Source note. Please activate a Source note or its Cue/Summary note.");
			this.isSwitchingMode = false;
            return;
        }

		try {
			console.log(`Cornell Plugin: Target Source file - ${sourceFile.path}`);

            // --- Clean Up Previous State ---
            const requiredPositions = this.getRequiredPositions(mode);
            // If the source file has changed, clear everything from the previous setup
			if (this.activeSourceFileForCornell && this.activeSourceFileForCornell.path !== sourceFile.path) {
				console.log("Cornell Plugin: Active Source file changed, clearing previous Cornell state.");
				await this.clearCornellState(true); // Detach old leaves completely
			} else {
                // Otherwise, just clean up leaves not needed for the new mode
				await this.cleanupUnneededLeaves(requiredPositions);
			}
			this.activeSourceFileForCornell = sourceFile;

            // --- Get or Create Cue/Summary Files ---
            const noteInfo = this.getOrCreateNoteInfo(sourceFile);
            const cuePath = this.getCueNotePath(sourceFile);
            const summaryPath = this.getSummaryNotePath(sourceFile);

            const cueFile = await this.ensureCueNoteExists(cuePath, sourceFile);
            if (!cueFile) throw new Error(`Failed to ensure Cue note exists at ${cuePath}`);

            let summaryFile: TFile | null = null;
            // Summary needed for recall, review, and show-all modes
            if (mode === 'recall' || mode === 'review' || mode === 'show-all') {
                 summaryFile = await this.ensureSummaryNoteExists(summaryPath, sourceFile, cueFile);
                 if (!summaryFile) console.warn(`Cornell Plugin: Could not create or find Summary note at ${summaryPath}. Mode ${mode} might be incomplete.`);
                 // Update noteInfo map after ensuring existence
                 noteInfo.summaryPath = summaryFile ? summaryFile.path : null;
            }
            noteInfo.cuePath = cueFile.path;
            this.noteInfoMap.set(sourceFile.path, noteInfo); // Update map
            await this.saveData(); // Save potentially updated map

			// --- Save State (if not restoring and not show-all) ---
            // Don't save 'show-all' as the last state for restore
			if (!isRestore && mode !== 'show-all') {
				this.settings.lastMode = mode;
				this.settings.lastFile = sourceFile.path; // Save SOURCE file path
				await this.saveData();
				console.log(`Cornell Plugin: Saved state: Mode=${mode}, File=${sourceFile.path}`);
            } else if (!isRestore && mode === 'show-all') {
                // Clear last state when activating show-all manually, so it doesn't restore
                this.settings.lastMode = null;
                this.settings.lastFile = null;
                await this.saveData();
                console.log(`Cornell Plugin: Activated 'show-all' mode. Last state cleared.`);
            }

            // --- Initial Sync S->C (ensure Cue note has definitions) ---
            // Run S->C sync before setting up the layout to populate the cue note
            console.log(`[ActivateMode] Running S->C sync for ${sourceFile.basename} -> ${cueFile.basename}`);
            await this.syncSourceToCue(sourceFile); // Run sync after ensuring files exist

			// --- Ensure Layout and Get Leaves ---
            // Pass the required files to the layout function
            const filesForMode: { [key in LeafPosition]?: TFile | null } = {};
            if (requiredPositions.includes('left')) filesForMode.left = cueFile;
            if (requiredPositions.includes('center')) filesForMode.center = sourceFile;
            if (requiredPositions.includes('right')) filesForMode.right = summaryFile;

			const finalLeaves = await this.ensureLeafLayout(requiredPositions, filesForMode);
			this.activeCornellLeaves = finalLeaves; // Update the tracked leaves

			// --- Setup Content (View Mode) in Leaves ---
			await this.setupLeavesContent(mode); // Sets preview/source modes

			// --- Apply Styles, Focus, and Scroll ---
			this.applyStylesAndWidth(mode); // Pass mode to potentially adjust ratios
			const finalFocusLeaf = this.getFinalFocusLeaf(mode);
			await this.applyFocusAndScroll(finalFocusLeaf, sourceFile, cueFile, summaryFile); // Pass files for scrolling

			console.log(`Cornell Plugin: Mode ${mode} activated successfully for ${sourceFile.path}.`);

		} catch (error) {
			console.error(`Cornell Plugin: Error activating Cornell mode "${mode}" for ${sourceFile?.path}:`, error);
			new Notice(`Failed to activate Cornell mode. ${error instanceof Error ? error.message : 'Check console for details.'}`);
			await this.clearCornellState(true); // Clean up on error
            // Clear saved state on failure
			this.settings.lastMode = null;
			this.settings.lastFile = null;
			await this.saveData();
		} finally {
			this.isSwitchingMode = false;
			console.log(`Cornell Plugin: Mode switch finished for ${mode}.`);
		}
	}

	/** Determines which leaf positions are required for a given mode. */
	private getRequiredPositions(mode: CornellMode): LeafPosition[] {
		switch (mode) {
			case 'capture': return ['left', 'center'];    // Cue, Source
			case 'recall': return ['left', 'right'];     // Cue, Summary
			case 'review': return ['center', 'right'];   // Source, Summary
            case 'show-all': return ['left', 'center', 'right']; // Cue, Source, Summary
			default:
				console.warn(`Cornell Plugin: Unknown mode "${mode}" in getRequiredPositions.`);
				return [];
		}
	}

    /**
	 * Helper to get or create a leaf for a specific position, ensuring it's a MarkdownView
	 * containing the target file for that position (Cue, Source, or Summary).
     * Prioritizes reusing existing tracked leaves if they contain the correct file.
	 */
	private async getOrCreateLeaf(position: LeafPosition, targetFile: TFile): Promise<WorkspaceLeaf> {
		console.log(`Cornell Plugin: Getting or creating leaf for position: ${position} with file ${targetFile.path}`);

		let leaf = this.activeCornellLeaves[position];
		let leafIsValid = false;
		if (leaf) {
			let exists = false;
            this.app.workspace.iterateAllLeaves(l => { if (l === leaf) exists = true; });
            // Check if the existing leaf holds the CORRECT file for this position
			if (exists && leaf.view instanceof MarkdownView && leaf.view.file?.path === targetFile.path) {
				console.log(`Cornell Plugin: Reusing valid tracked leaf for ${position} (${targetFile.basename}).`);
				leafIsValid = true;
			} else {
				console.log(`Cornell Plugin: Tracked leaf for ${position} is invalid (exists: ${exists}, file: ${leaf?.view instanceof MarkdownView ? leaf.view.file?.path : 'N/A'}, expected: ${targetFile.path}). Clearing.`);
				this.activeCornellLeaves[position] = null; // Clear invalid tracked leaf
				leaf = null;
			}
		}

        // If no valid tracked leaf, try finding ANY existing leaf with the target file
		if (!leafIsValid) {
			leaf = this.findExistingLeafForFile(targetFile);
			if (leaf) {
                // If found, check if it's already assigned to a DIFFERENT Cornell position
                let assignedToOther = false;
                for (const pos in this.activeCornellLeaves) {
                    if (pos !== position && this.activeCornellLeaves[pos as LeafPosition] === leaf) {
                        assignedToOther = true;
                        break;
                    }
                }
                if (assignedToOther) {
                    console.log(`Cornell Plugin: Found existing leaf for ${targetFile.basename}, but it's assigned to another Cornell position. Will create new.`);
                    leaf = null; // Force creation of a new leaf
                } else {
				    console.log(`Cornell Plugin: Found existing unassigned leaf for ${position} containing ${targetFile.basename}.`);
				    leafIsValid = true;
                }
			}
		}

		// If still no leaf, create a new one
        if (!leaf) {
			console.log(`Cornell Plugin: No suitable existing leaf found for ${position}. Creating new leaf.`);
			leaf = this.app.workspace.getLeaf('tab'); // Create new tab leaf
			if (!leaf) throw new Error(`Failed to create new leaf for ${position}.`);
			console.log(`Cornell Plugin: New leaf created for ${position}.`);
			leafIsValid = false; // Needs file opened
		}

        // Ensure the chosen/created leaf has the correct file opened
		if (!leafIsValid || !(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== targetFile.path) {
			console.log(`Cornell Plugin: Preparing leaf for ${position} - ensuring file ${targetFile.basename}.`);
			try {
                await this.openFileInLeaf(leaf, targetFile, false); // Open file, don't activate yet
                await sleep(150); // Allow time for file to open and view to be ready

				if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== targetFile.path) {
                    // Fallback using setViewState if openFile didn't work as expected
                    console.warn(`Cornell Plugin: openFile didn't result in MarkdownView for ${targetFile.basename}. Trying setViewState.`);
                    const viewState: ViewState = {
						type: 'markdown',
						state: { file: targetFile.path, mode: position === 'left' ? 'preview' : 'source' }, // Set initial mode based on position
						active: false
					};
					await leaf.setViewState(viewState, { history: false });
                    await sleep(150);
                    if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== targetFile.path) {
					    throw new Error(`Leaf preparation failed for ${position}. Current type: ${leaf.view?.getViewType()}, File: ${(leaf.view as any)?.file?.path}`);
                    }
				}
				console.log(`Cornell Plugin: Leaf for ${position} successfully prepared with ${targetFile.basename}.`);
			} catch (error) {
				console.error(`Error preparing leaf for ${position} with file ${targetFile.path}:`, error);
				if (leaf && leaf.parent) try { leaf.detach(); } catch { } // Clean up failed leaf
                this.activeCornellLeaves[position] = null; // Ensure it's cleared
				throw error;
			}
		}

		this.activeCornellLeaves[position] = leaf; // Track the prepared leaf
		return leaf;
	}

	/**
	 * Ensures the required leaves exist, contain the correct files, and arranges them horizontally.
	 * @param requiredPositions Which positions (left, center, right) are needed.
	 * @param filesForMode A map containing the TFile object for each required position.
	 */
	private async ensureLeafLayout(
		requiredPositions: LeafPosition[],
		filesForMode: { [key in LeafPosition]?: TFile | null }
	): Promise<{ left: WorkspaceLeaf | null, center: WorkspaceLeaf | null, right: WorkspaceLeaf | null }> {
		console.log("Cornell Plugin: Ensuring leaf layout for positions:", requiredPositions);
		const result: { left: WorkspaceLeaf | null, center: WorkspaceLeaf | null, right: WorkspaceLeaf | null } = {
			left: null, center: null, right: null,
		};
		const leavesToArrange: WorkspaceLeaf[] = [];
        const creationPromises: Promise<void>[] = [];

        // Get or create leaves for each required position in parallel
        requiredPositions.forEach(pos => {
            const targetFile = filesForMode[pos];
            if (!targetFile) {
                // Only warn if the file is actually required for the mode but missing
                // (Summary might be null if creation failed but mode proceeds)
                if ( (pos === 'left' || pos === 'center') || // Cue and Source are generally essential
                     ( (pos === 'right') && (this.getRequiredPositions(this.settings.lastMode ?? 'capture').includes('right')) ) // Summary essential if mode needs it
                   ) {
                     console.warn(`Cornell Plugin: Target file missing for required position ${pos}. Layout might be incomplete.`);
                }
                return; // Skip if no file specified or found for a position
            }
            creationPromises.push(
                (async () => {
                    try {
                        const leaf = await this.getOrCreateLeaf(pos, targetFile);
                        result[pos] = leaf;
                    } catch (err) {
                        console.error(`Failed to get or create leaf for ${pos} (${targetFile.basename}):`, err);
                        // Mark as null if failed
                        result[pos] = null;
                        // Don't throw here, allow arrangement to proceed with available leaves if possible
                        // throw new Error(`Layout setup failed: Could not prepare leaf for ${pos}.`);
                    }
                })()
            );
        });
        await Promise.all(creationPromises); // Wait for all leaves to be ready

        // Determine the order for arrangement based on required positions, filtering out failed leaves (nulls)
        if (requiredPositions.includes('left') && result.left) leavesToArrange.push(result.left);
        if (requiredPositions.includes('center') && result.center) leavesToArrange.push(result.center);
        if (requiredPositions.includes('right') && result.right) leavesToArrange.push(result.right);

        // Filter out any nulls again just in case (shouldn't be necessary after push logic)
        const validLeavesToArrange = leavesToArrange.filter((l): l is WorkspaceLeaf => l !== null);

        if (validLeavesToArrange.length === 0) {
            throw new Error("No valid leaves could be prepared for the layout.");
        }
		if (validLeavesToArrange.length === 1) {
			// If only one leaf, ensure it's not split unnecessarily
			const singleLeaf = validLeavesToArrange[0];
            if (singleLeaf.parent && 'children' in singleLeaf.parent && Array.isArray(singleLeaf.parent.children) && singleLeaf.parent.children.length > 1) {
				console.log("Cornell Plugin: Only one leaf in layout, ensuring it's tracked.");
			}
		} else if (validLeavesToArrange.length > 1) {
			// Arrange the leaves horizontally using splitLeaf
            const arrangingSourceFile = filesForMode.center ?? filesForMode.left ?? filesForMode.right;
            if (!arrangingSourceFile) {
                throw new Error("Cannot arrange leaves: No valid source file context found.");
            }
            const arrangedLeaves = await this.arrangeLeavesHorizontally(validLeavesToArrange, arrangingSourceFile);

            // Update the result map with potentially new leaf objects created by splitLeaf
            let arrangedIndex = 0;
            if (requiredPositions.includes('left') && result.left) {
                // Find the leaf corresponding to the left file in the *newly* arranged leaves
                const newLeaf = arrangedLeaves.find(l => l.view instanceof MarkdownView && l.view.file?.path === filesForMode.left?.path);
                result.left = newLeaf || result.left; // Use the new leaf if found, otherwise keep original (should exist)
            }
             if (requiredPositions.includes('center') && result.center) {
                const newLeaf = arrangedLeaves.find(l => l.view instanceof MarkdownView && l.view.file?.path === filesForMode.center?.path);
                result.center = newLeaf || result.center;
            }
             if (requiredPositions.includes('right') && result.right) {
                const newLeaf = arrangedLeaves.find(l => l.view instanceof MarkdownView && l.view.file?.path === filesForMode.right?.path);
                 result.right = newLeaf || result.right;
            }
		}

		console.log("Cornell Plugin: Leaf layout ensured. Final structure:", {
			left: result.left ? `Leaf Exists (${result.left.view instanceof MarkdownView ? result.left.view.file?.basename : 'N/A'})` : null,
			center: result.center ? `Leaf Exists (${result.center.view instanceof MarkdownView ? result.center.view.file?.basename : 'N/A'})` : null,
			right: result.right ? `Leaf Exists (${result.right.view instanceof MarkdownView ? result.right.view.file?.basename : 'N/A'})` : null
		});
		return result;
	}


	/**
	 * Arranges the provided leaves horizontally using workspace.createLeafBySplit.
     * Assumes the first leaf in the array is the anchor.
     * Tries to open the correct file in the newly created leaves.
	 */
	private async arrangeLeavesHorizontally(leaves: WorkspaceLeaf[], contextFile: TFile): Promise<WorkspaceLeaf[]> {
		if (leaves.length <= 1) return leaves;

		console.log(`Cornell Plugin: Arranging ${leaves.length} leaves horizontally...`);
		const finalLeaves: WorkspaceLeaf[] = [leaves[0]]; // Start with the first leaf as the anchor

		let previousLeafInLayout = leaves[0];
        // Ensure the first leaf is attached to the workspace
        let leafExists = false;
        this.app.workspace.iterateAllLeaves(leaf => { if (leaf === previousLeafInLayout) leafExists = true; });
        if (!previousLeafInLayout.parent || !leafExists) {
			console.warn("Cornell Plugin: First leaf for arrangement is detached or not found. Re-attaching or creating new.");
            // Attempt to re-attach or get a new leaf if the anchor is lost
            const reAttachedLeaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
            if (!reAttachedLeaf) throw new Error("Cannot arrange leaves: Failed to get a valid starting leaf.");
            if (previousLeafInLayout.view instanceof MarkdownView && previousLeafInLayout.view.file) {
                await this.openFileInLeaf(reAttachedLeaf, previousLeafInLayout.view.file, false);
            } else {
                 await this.openFileInLeaf(reAttachedLeaf, contextFile, false); // Open context file as fallback
            }
            previousLeafInLayout = reAttachedLeaf;
            finalLeaves[0] = reAttachedLeaf; // Update the anchor
			// throw new Error("Cannot arrange leaves: the starting leaf is detached.");
		}

		for (let i = 1; i < leaves.length; i++) {
			const originalLeafToPlace = leaves[i];
            const targetFileForThisLeaf = originalLeafToPlace.view instanceof MarkdownView ? originalLeafToPlace.view.file : null;
            if (!targetFileForThisLeaf) {
                console.warn(`Cornell Plugin: Could not determine target file for leaf at index ${i}. Skipping arrangement for this leaf.`);
                continue; // Skip if we don't know what file to put in the new leaf
            }

			console.log(`Cornell Plugin: Placing leaf ${i} (${targetFileForThisLeaf.basename}) relative to leaf ${i - 1}.`);

            // If the leaf to place is the same as the previous one (shouldn't happen with unique leaves), skip
			if (previousLeafInLayout === originalLeafToPlace) {
				console.warn(`Warning: Attempting to arrange the same leaf at position ${i - 1} and ${i}. Skipping split.`);
				continue;
			}

            // Detach the original leaf if it exists and is not already the previous leaf
            let originalLeafDetached = false;
            let exists = false;
            this.app.workspace.iterateAllLeaves(l => { if (l === originalLeafToPlace) exists = true; });
            if (originalLeafToPlace.parent && exists) {
				console.log(`Cornell Plugin: Detaching original leaf intended for position ${i} (${targetFileForThisLeaf.basename}) before splitting.`);
                try {
				    originalLeafToPlace.detach();
                    originalLeafDetached = true;
                    await sleep(50);
                } catch (detachError) {
                    console.error("Error detaching original leaf:", detachError);
                }
			}

			try {
				console.log(`Cornell Plugin: Splitting vertically from previous leaf (${previousLeafInLayout.view instanceof MarkdownView ? previousLeafInLayout.view.file?.basename : 'N/A'}) to create space for leaf ${i}`);
				const newLeaf = this.app.workspace.createLeafBySplit(previousLeafInLayout, 'vertical'); // Split vertically for horizontal layout
				if (!newLeaf) throw new Error(`this.app.workspace.createLeafBySplit returned null when placing leaf ${i}`);

				console.log(`Cornell Plugin: Created new leaf by splitting. Opening file ${targetFileForThisLeaf.basename} in it.`);

                await this.openFileInLeaf(newLeaf, targetFileForThisLeaf, false); // Open the correct file
                await sleep(150); // Allow file open

				if (!(newLeaf.view instanceof MarkdownView) || newLeaf.view.file?.path !== targetFileForThisLeaf.path) {
					console.error(`Failed to set up newly split leaf ${i}. Type: ${newLeaf.view?.getViewType()}, File: ${(newLeaf.view as any)?.file?.path}, Expected: ${targetFileForThisLeaf.path}`);
                    // Attempt setViewState as fallback
                    await newLeaf.setViewState({
                        type: 'markdown',
                        state: { file: targetFileForThisLeaf.path, mode: 'source' }, // Default to source, will be set later
                        active: false
                    }, { history: false });
                    await sleep(100);
                    if (!(newLeaf.view instanceof MarkdownView) || newLeaf.view.file?.path !== targetFileForThisLeaf.path) {
                        throw new Error(`Newly split leaf failed to become MarkdownView with the correct file for position ${i}.`);
                    }
				}

				finalLeaves.push(newLeaf); // Add the newly created and populated leaf
				previousLeafInLayout = newLeaf; // Update the anchor for the next split
				console.log(`Cornell Plugin: Leaf ${i} (${targetFileForThisLeaf.basename}) successfully placed.`);

			} catch (splitError) {
				console.error(`Error creating split for leaf ${i} from previous leaf:`, splitError);
				// Clean up leaves created so far in this arrangement attempt
                await Promise.all(finalLeaves.slice(1).map(async (l) => { // Detach leaves created *during* this arrangement
                    if (l?.parent) try { l.detach(); } catch { }
                }));
				throw new Error(`Failed to arrange leaves using splitLeaf method at step ${i}.`);
			}
		}
		console.log("Cornell Plugin: Leaf arrangement completed.");
		return finalLeaves; // Return the array of leaves in their final arranged order/objects
	}

	/**
	 * Sets the view mode (source/preview) and applies CSS classes for the active Cornell leaves based on the mode.
	 */
	private async setupLeavesContent(mode: CornellMode): Promise<void> {
		console.log(`Cornell Plugin: Setting up leaf content modes and styles for mode: ${mode}`);
		const setupTasks: Promise<void>[] = [];

        // Helper to configure a single leaf
		const setupLeaf = async (
			leaf: WorkspaceLeaf | null,
            position: LeafPosition,
			viewMode: 'source' | 'preview',
			cssClass: string
		): Promise<void> => {
			if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.parent) {
				console.log(`Cornell Plugin: Skipping setup for leaf (${position}) - leaf is null, not Markdown, or detached.`);
				return;
			}
            const view = leaf.view;
			console.log(`Cornell Plugin: Setting up ${position} leaf (${view.file?.basename}). Mode: ${viewMode}, Class: ${cssClass}.`);

            // Clear existing Cornell classes first
			view.containerEl?.classList.remove(
				CORNELL_PANE_CLASS, CORNELL_LEFT_PANE_CLASS, CORNELL_CENTER_PANE_CLASS, CORNELL_RIGHT_PANE_CLASS
			);
            // Add new classes
			view.containerEl?.classList.add(CORNELL_PANE_CLASS, cssClass);

			try {
                // Enforce preview for left pane (Cue) if setting is enabled
                const targetMode = (position === 'left' && this.settings.enforceCuePreview) ? 'preview' : viewMode;
				await this.setMarkdownViewMode(view, targetMode);
			} catch (error) {
				console.error(`Failed setting mode to ${viewMode} for ${position} leaf ${view.file?.path}:`, error);
			}
		};

        // Remove styles/classes from leaves not used in this mode
        const requiredPositions = this.getRequiredPositions(mode);
        (Object.keys(this.activeCornellLeaves) as LeafPosition[]).forEach(pos => {
            if (!requiredPositions.includes(pos)) {
                const leaf = this.activeCornellLeaves[pos];
                leaf?.view?.containerEl?.classList.remove(CORNELL_PANE_CLASS, CORNELL_LEFT_PANE_CLASS, CORNELL_CENTER_PANE_CLASS, CORNELL_RIGHT_PANE_CLASS);
                // Reset flex style if it was applied
                if (leaf?.view?.containerEl) {
                    leaf.view.containerEl.style.flex = '';
                }
            }
        });

        // Configure leaves required for the current mode
		switch (mode) {
			case 'capture': // Left (Cue, Preview), Center (Source, Source)
				if (this.activeCornellLeaves.left) setupTasks.push(setupLeaf(this.activeCornellLeaves.left, 'left', 'preview', CORNELL_LEFT_PANE_CLASS));
				if (this.activeCornellLeaves.center) setupTasks.push(setupLeaf(this.activeCornellLeaves.center, 'center', 'source', CORNELL_CENTER_PANE_CLASS));
				break;
			case 'recall': // Left (Cue, Preview), Right (Summary, Source)
				if (this.activeCornellLeaves.left) setupTasks.push(setupLeaf(this.activeCornellLeaves.left, 'left', 'preview', CORNELL_LEFT_PANE_CLASS));
				if (this.activeCornellLeaves.right) setupTasks.push(setupLeaf(this.activeCornellLeaves.right, 'right', 'source', CORNELL_RIGHT_PANE_CLASS));
				break;
			case 'review': // Center (Source, Source), Right (Summary, Source)
				if (this.activeCornellLeaves.center) setupTasks.push(setupLeaf(this.activeCornellLeaves.center, 'center', 'source', CORNELL_CENTER_PANE_CLASS));
				if (this.activeCornellLeaves.right) setupTasks.push(setupLeaf(this.activeCornellLeaves.right, 'right', 'source', CORNELL_RIGHT_PANE_CLASS));
				break;
            case 'show-all': // Left (Cue, Preview), Center (Source, Source), Right (Summary, Source)
				if (this.activeCornellLeaves.left) setupTasks.push(setupLeaf(this.activeCornellLeaves.left, 'left', 'preview', CORNELL_LEFT_PANE_CLASS));
				if (this.activeCornellLeaves.center) setupTasks.push(setupLeaf(this.activeCornellLeaves.center, 'center', 'source', CORNELL_CENTER_PANE_CLASS));
                if (this.activeCornellLeaves.right) setupTasks.push(setupLeaf(this.activeCornellLeaves.right, 'right', 'source', CORNELL_RIGHT_PANE_CLASS));
				break;
		}
		await Promise.all(setupTasks);
		await sleep(100); // Short delay for rendering
		console.log("Cornell Plugin: Leaf content setup complete.");
	}


	/** Determines which leaf should receive focus based on the mode. */
	private getFinalFocusLeaf(mode: CornellMode): WorkspaceLeaf | null {
		switch (mode) {
			case 'capture': return this.activeCornellLeaves.center; // Focus Source
			case 'recall': return this.activeCornellLeaves.right;  // Focus Summary
			case 'review': return this.activeCornellLeaves.right;  // Focus Summary
            case 'show-all': return this.activeCornellLeaves.center; // Focus Source in show-all mode
			default: return null;
		}
	}

	/** Applies styles (width). Can adjust ratios based on mode. */
	private applyStylesAndWidth(mode?: CornellMode): void {
		console.log("Cornell Plugin: Applying styles and widths...");
        // Use specific ratios for 'show-all' mode, otherwise use settings
        const ratio = (mode === 'show-all')
            ? { left: 33, center: 34, right: 33 } // Equal distribution for show-all
            : this.settings.paneWidthRatio;
		this.adjustPaneWidths(ratio); // Pass the chosen ratio
	}

	/** Sets focus and scrolls panes to relevant sections. */
	private async applyFocusAndScroll(
		finalFocusLeaf: WorkspaceLeaf | null,
        sourceFile: TFile,
        cueFile: TFile,
        summaryFile: TFile | null
	): Promise<void> {
		console.log("Cornell Plugin: Applying focus and scroll...");
		await sleep(50);

		// --- Focus ---
		if (finalFocusLeaf) {
			let exists = false;
            this.app.workspace.iterateAllLeaves(l => { if (l === finalFocusLeaf) exists = true; });
			if (exists && finalFocusLeaf.parent) {
				console.log(`Cornell Plugin: Setting final focus to leaf (${finalFocusLeaf.view instanceof MarkdownView ? finalFocusLeaf.view.file?.basename : 'N/A'}).`);
				this.app.workspace.setActiveLeaf(finalFocusLeaf, { focus: true });
				await sleep(100); // Allow focus to take effect
			} else {
				console.warn(`Cornell Plugin: Leaf intended for focus no longer exists or is detached.`);
                // Fallback focus to center if available
                if (this.activeCornellLeaves.center?.parent) {
                    this.app.workspace.setActiveLeaf(this.activeCornellLeaves.center, { focus: true });
                     await sleep(100);
                }
			}
		} else {
			console.log("Cornell Plugin: No specific leaf targeted for final focus.");
            // Fallback: Ensure the source pane (center) is focused if available
            if (this.activeCornellLeaves.center?.parent) {
                this.app.workspace.setActiveLeaf(this.activeCornellLeaves.center, { focus: true });
                await sleep(100);
            }
		}

		// --- Scroll ---
        // Find section lines in each relevant file
        const scrollTasks: Promise<void>[] = [];
        try {
            const sourceContent = await this.app.vault.cachedRead(sourceFile);
            const cueContent = await this.app.vault.cachedRead(cueFile);
            const summaryContent = summaryFile ? await this.app.vault.cachedRead(summaryFile) : "";

            const sectionLines = {
                CUE: this.findSectionLine(cueContent, "CUE") ?? 0,
                MAIN: this.findSectionLine(sourceContent, "MAIN") ?? 0,
                SUMMARY: this.findSectionLine(summaryContent, "SUMMARY") ?? 0
            };

            console.log("Section lines found:", sectionLines);

            // Scroll each active pane to its corresponding section
            if (this.activeCornellLeaves.left?.parent) {
                scrollTasks.push(this.scrollToSection(this.activeCornellLeaves.left, sectionLines.CUE));
            }
            if (this.activeCornellLeaves.center?.parent) {
                scrollTasks.push(this.scrollToSection(this.activeCornellLeaves.center, sectionLines.MAIN));
            }
            if (this.activeCornellLeaves.right?.parent) {
                scrollTasks.push(this.scrollToSection(this.activeCornellLeaves.right, sectionLines.SUMMARY));
            }

            if (scrollTasks.length > 0) {
                console.log(`Cornell Plugin: Executing ${scrollTasks.length} scroll tasks.`);
                await Promise.all(scrollTasks);
                await sleep(50); // Allow scrolls to finish
                console.log("Cornell Plugin: Scrolling tasks complete.");
            } else {
                console.log("Cornell Plugin: No active panes to scroll.");
            }
        } catch (readError) {
             console.error("Cornell Plugin: Error reading file content for scrolling:", readError);
        }
	}

	// Helper to find the line number of a section header (e.g., ## CUE)
	findSectionLine(content: string, section: 'CUE' | 'MAIN' | 'SUMMARY'): number | null {
        if (!content) return null;
		const lines = content.split('\n');
		// Matches ## CUE, ##CUE, ## Cue, etc. at the start of a line
		const regex = new RegExp(`^##\\s*${section}\\b.*`, 'i');
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i].trim())) {
				// console.log(`Cornell Plugin: Found "## ${section}" at line ${i} in content.`);
				return i;
			}
		}
		// console.warn(`Cornell Plugin: Section header "## ${section}" not found in the provided content.`);
		return null;
	}

	// Helper function to scroll a leaf's view to a specific line
	async scrollToSection(leaf: WorkspaceLeaf | null, line: number | null): Promise<void> {
		if (!leaf || line === null || !(leaf.view instanceof MarkdownView) || !leaf.parent) {
			// console.log(`Cornell Plugin: Skipping scroll for leaf - invalid input or leaf detached.`);
			return;
		}
		const view = leaf.view;
        const targetMode = view.getMode(); // Scroll in the current mode
		// console.log(`Cornell Plugin: Scrolling leaf ${view.file?.path} to line ${line} (current mode: ${targetMode}).`);

		try {
			// No need to switch mode here, scroll in the current mode
			if (targetMode === 'source') {
				const editor = view.editor;
				if (!editor) {
					console.warn(`Cornell Plugin: Editor not available for source mode scroll in ${view.file?.path}.`);
					return;
				}
				const lineCount = editor.lineCount();
				const targetLine = Math.max(0, Math.min(line, lineCount > 0 ? lineCount - 1 : 0));
				const position: EditorPosition = { line: targetLine, ch: 0 };
				// console.log(`Cornell Plugin: Scrolling source editor to line ${targetLine}.`);
                // Use scrollIntoView with center alignment if possible
				editor.scrollIntoView({ from: position, to: position }, true);
                // Set cursor after scrolling
                await sleep(50); // Allow scroll animation
                editor.setCursor(position);
			} else { // Preview mode scroll
				// Use the internal scroll function which handles preview scrolling
                // Ensure previewMode object exists
                if (view.previewMode) {
				    view.previewMode.applyScroll(line);
				    // console.log(`Cornell Plugin: Scrolling preview for ${view.file?.path} to line ${line}.`);
                } else {
                    console.warn(`Cornell Plugin: previewMode not available for scrolling in ${view.file?.path}`);
                }
			}
			await sleep(50);
			// console.log(`Cornell Plugin: Scroll command issued for leaf ${view.file?.path}.`);
		} catch (scrollError) {
			console.error(`Cornell Plugin: Error during scroll on leaf ${view.file?.path}:`, scrollError);
		}
	}

	// Adjust pane widths based on settings using flexbox
	adjustPaneWidths(ratio = this.settings.paneWidthRatio): void {
		const { left, center, right } = this.activeCornellLeaves;
		// const ratio = this.settings.paneWidthRatio; // Use passed ratio or default

		const activeLeavesMap: { [key in LeafPosition]?: WorkspaceLeaf } = {};
		let totalRatioUnits = 0;
		let activePaneCount = 0;

        // Check which panes are actually active and visible
		if (left?.parent && left.view?.containerEl) {
			activeLeavesMap.left = left;
			totalRatioUnits += ratio.left;
			activePaneCount++;
		}
		if (center?.parent && center.view?.containerEl) {
			activeLeavesMap.center = center;
			totalRatioUnits += ratio.center;
			activePaneCount++;
		}
		if (right?.parent && right.view?.containerEl) {
			activeLeavesMap.right = right;
			totalRatioUnits += ratio.right;
			activePaneCount++;
		}

		if (activePaneCount === 0) {
			return;
		}

		console.log(`Cornell Plugin: Adjusting widths for ${activePaneCount} panes. Ratios: L=${ratio.left}, C=${ratio.center}, R=${ratio.right}. Total units: ${totalRatioUnits}.`);

        // Calculate flex-basis percentage
		const calculateBasis = (leafRatio: number): string => {
			if (totalRatioUnits <= 0 || activePaneCount <= 0) {
				return `${100 / (activePaneCount || 1)}%`; // Equal distribution fallback
			}
			const percentage = (leafRatio / totalRatioUnits) * 100;
			return `${percentage}%`;
		};

        // Apply flex style to the container element of the view
		const setWidth = (leaf: WorkspaceLeaf | undefined, basis: string, leafRatio: number) => {
			const containerEl = leaf?.view?.containerEl;
			if (containerEl) {
                const flexGrow = (totalRatioUnits <= 0) ? 1 : leafRatio;
				containerEl.style.flex = `${flexGrow} 1 ${basis}`;
				// console.log(`Cornell Plugin: Applied flex=${containerEl.style.flex} to leaf (${leaf.view instanceof MarkdownView ? leaf.view.file?.basename : 'N/A'})`);
			}
		};

        // Apply widths only to the panes active in the current layout
		if (activeLeavesMap.left) setWidth(activeLeavesMap.left, calculateBasis(ratio.left), ratio.left);
		if (activeLeavesMap.center) setWidth(activeLeavesMap.center, calculateBasis(ratio.center), ratio.center);
		if (activeLeavesMap.right) setWidth(activeLeavesMap.right, calculateBasis(ratio.right), ratio.right);
	}


	// --- Leaf Management Helpers (Adapted from main.ts その1) ---

    /** Find an existing, attached Markdown leaf containing the target file */
    private findExistingLeafForFile(file: TFile): WorkspaceLeaf | null {
        let foundLeaf: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (foundLeaf) return; // Stop searching once found
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path && leaf.parent) {
                foundLeaf = leaf;
            }
        });
        return foundLeaf;
    }

	/**
	 * Detaches leaves that are currently tracked but not needed for the target layout.
	 */
	private async cleanupUnneededLeaves(neededPositions: LeafPosition[]): Promise<void> {
		console.log("Cornell Plugin: Cleaning up unneeded leaves...");
		const cleanupTasks: Promise<void>[] = [];
		const currentLeaves = { ...this.activeCornellLeaves }; // Operate on a copy

		(Object.keys(currentLeaves) as LeafPosition[]).forEach(pos => {
			const leaf = currentLeaves[pos];
			// If a leaf exists for this position but is NOT needed in the new layout
			if (leaf && !neededPositions.includes(pos)) {
				console.log(`Cornell Plugin: Detaching unneeded leaf at position ${pos} (${leaf.view instanceof MarkdownView ? leaf.view.file?.basename : 'N/A'}).`);
				cleanupTasks.push((async () => {
					try {
						// Double-check if the leaf still exists in the workspace
                        let exists = false;
                        this.app.workspace.iterateAllLeaves(l => { if (l === leaf) exists = true; });

						if (exists && leaf.parent) {
							// Remove Cornell CSS classes before detaching
							leaf.view?.containerEl?.classList.remove(CORNELL_PANE_CLASS, CORNELL_LEFT_PANE_CLASS, CORNELL_CENTER_PANE_CLASS, CORNELL_RIGHT_PANE_CLASS);
                            // Reset flex style
                            if (leaf.view?.containerEl) leaf.view.containerEl.style.flex = '';
							leaf.detach(); // Detach the leaf
						}
					} catch (error) {
						console.error(`Error detaching leaf for position ${pos}:`, error);
					} finally {
                        // Always clear the reference in the main tracking object
                        if (this.activeCornellLeaves[pos] === leaf) {
						    this.activeCornellLeaves[pos] = null;
                        }
                    }
				})());
			}
		});

		try {
			await Promise.all(cleanupTasks);
			console.log("Cornell Plugin: Unneeded leaf cleanup completed.");
		} catch (error) {
			console.error("Error waiting for unneeded leaf cleanup:", error);
		}
	}

	/**
	 * Clears all tracked Cornell state and optionally detaches all tracked leaves.
     * @param forceDetachAll If true (e.g., on unload), detach leaves. If false (e.g., on error), just remove styles/tracking.
	 */
	private async clearCornellState(forceDetachAll: boolean = true): Promise<void> {
		console.log(`Cornell Plugin: Clearing Cornell state (Force detach all: ${forceDetachAll})`);
		// Get a list of unique leaves currently tracked
		const leavesToCleanup = [
			this.activeCornellLeaves.left,
			this.activeCornellLeaves.center,
			this.activeCornellLeaves.right
		].filter((leaf): leaf is WorkspaceLeaf => leaf !== null);

		const uniqueLeaves = [...new Set(leavesToCleanup)];

		const cleanupPromises = uniqueLeaves.map(async (leaf) => {
			try {
				// Check if the leaf still exists in the workspace
                let exists = false;
                this.app.workspace.iterateAllLeaves(l => { if (l === leaf) exists = true; });

                if (exists && leaf.parent) {
                    // Remove styles regardless
                    leaf.view?.containerEl?.classList.remove(CORNELL_PANE_CLASS, CORNELL_LEFT_PANE_CLASS, CORNELL_CENTER_PANE_CLASS, CORNELL_RIGHT_PANE_CLASS);
                    if (leaf.view?.containerEl) leaf.view.containerEl.style.flex = ''; // Reset flex

                    if (forceDetachAll) {
                        console.log(`Cornell Plugin: Detaching leaf (${leaf.view instanceof MarkdownView ? leaf.view.file?.basename : 'N/A'}) in full clear.`);
                        leaf.detach();
                    }
                }
			} catch (error) {
				console.error(`Error during full leaf cleanup for leaf (${leaf.view instanceof MarkdownView ? leaf.view.file?.basename : 'N/A'}):`, error);
			}
		});

		try {
			await Promise.all(cleanupPromises);
			console.log("Cornell Plugin: Full leaf cleanup tasks completed.");
		} catch (error) {
			console.error("Error waiting for full leaf cleanup:", error);
		}

		// Reset tracked state AFTER cleanup attempts
		this.activeCornellLeaves = { left: null, center: null, right: null };
		this.activeSourceFileForCornell = null;
        // Optionally clear last state setting if fully resetting
        if (forceDetachAll) {
            this.settings.lastMode = null;
            this.settings.lastFile = null;
            // No need to save here, typically called during unload or error recovery where state shouldn't persist
        }
		console.log("Cornell Plugin: Cornell state cleared.");
	}


	// Set MarkdownView mode reliably (From main.ts その1, adapted)
	async setMarkdownViewMode(view: MarkdownView, mode: 'source' | 'preview'): Promise<void> {
        // Check if trying to switch Cue pane to source while enforcement is on
        if (this.settings.enforceCuePreview && view === this.activeCornellLeaves?.left?.view && mode === 'source') {
             console.log(`Cornell Plugin: Blocked attempt to switch Cue pane to source mode while enforcing preview.`);
             // new Notice("Cue pane is locked to Preview mode.");
             return; // Prevent switch
        }
		try {
			const prevState = view.getState();
			if (prevState.mode !== mode) {
				console.log(`Cornell Plugin: Setting mode to ${mode} for view: ${view.file?.path}`);
				const nextState: ViewState = {
					type: prevState.type as string,
					state: { ...(prevState.state || {}), mode: mode } // Correctly merge state
				};
                // Check if view is still valid before setting state
                if (!view.leaf || !view.leaf.parent) {
                    console.warn(`Cornell Plugin: View for ${view.file?.path} is detached. Cannot set mode.`);
                    return;
                }
				await view.setState(nextState, { history: false });
				await sleep(50); // Allow mode change to render
			}
		} catch (error) {
			console.error(`Failed to set mode to ${mode} for view ${view.file?.path}:`, error);
            // Don't rethrow, just log the error
		}
	}


	// --- Cue Generation Logic (Combined - writes to Cue Note) ---
	async generateCue(editor: Editor, view: MarkdownView) { // view is the SOURCE view
		const sourceFile = view.file;
        if (!sourceFile || !this.isSourceNote(sourceFile.path)) {
            new Notice("Cue generation must be run from the Source note.");
            return;
        }

		const selections = editor.listSelections();
		if (selections.length === 0 || (selections[0].anchor.line === selections[0].head.line && selections[0].anchor.ch === selections[0].head.ch)) {
			new Notice("Please select text in the Source note to create a Cue.");
			return;
		}
		const primarySelection = selections[0];
		const selectedText = editor.getRange(primarySelection.anchor, primarySelection.head);

		if (!selectedText || selectedText.trim().length === 0) {
			new Notice("Selected text is empty. Please select text to create a Cue.");
			return;
		}

        // Get the corresponding Cue file
        const cuePath = this.getCueNotePath(sourceFile);
        let cueFile : TFile | null = null;
        const cueFileAbstract = this.app.vault.getAbstractFileByPath(cuePath);


        // Ensure Cue note exists, create if necessary
        if (cueFileAbstract instanceof TFile) {
             cueFile = cueFileAbstract;
        } else {
            new Notice(`Cue note not found at ${cuePath}. Attempting to create...`);
            cueFile = await this.ensureCueNoteExists(cuePath, sourceFile);
            if (!cueFile) {
                new Notice(`Failed to create Cue note at ${cuePath}. Cannot generate Cue.`);
                return;
            }
            new Notice(`Created Cue note: ${cueFile.basename}`);
        }

		try {
            // 1. Determine the next footnote index/reference based on the CUE note content
			let cueContent = await this.app.vault.read(cueFile);
            const existingCueDefs = this.parseFootnotesSimple(cueContent); // Get existing definitions from Cue note
			const prefix = this.settings.cuePrefix.trim();
			let lastIndex = 0;

            existingCueDefs.forEach((_def, key) => {
                let num = NaN;
				if (prefix && key.startsWith(prefix)) {
					const numStr = key.substring(prefix.length);
					if (/^\d+$/.test(numStr)) num = parseInt(numStr, 10);
				} else if (!prefix && /^\d+$/.test(key)) {
					num = parseInt(key, 10);
				}
                if (!isNaN(num) && num > lastIndex) lastIndex = num;
            });

			const nextIndex = lastIndex + 1;
			const footnoteRef = prefix ? `[^${prefix}${nextIndex}]` : `[^${nextIndex}]`;

            // 2. Insert the footnote reference into the SOURCE note
            const insertPos = primarySelection.anchor.line < primarySelection.head.line ||
				(primarySelection.anchor.line === primarySelection.head.line && primarySelection.anchor.ch < primarySelection.head.ch)
				? primarySelection.head : primarySelection.anchor;

			editor.replaceRange(footnoteRef, insertPos); // Replace selection with reference
            // Optional: Move cursor after the inserted reference
            // const newCursorPos: EditorPosition = { line: insertPos.line, ch: insertPos.ch + footnoteRef.length };
            // editor.setCursor(newCursorPos);
            // editor.setSelection(newCursorPos, newCursorPos);

            // 3. Prepare and add the footnote definition to the CUE note content
			const cleanedSelection = selectedText.trim().replace(/\s+/g, ' ');
			const footnoteDefText = `${footnoteRef}: ${cleanedSelection}`;

            // Append the new definition to the Cue note content
            // We rely on syncSourceToCue to properly format/place it later,
            // but let's add it reasonably well here.
            const lines = cueContent.split('\n');
            let insertLineIndex = lines.length; // Default to end

            // Find the end of existing definitions or before the code block
            const codeBlockRegex = new RegExp(`^\\s*\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}`);
            let codeBlockLine = -1;
            for(let i = lines.length -1; i >= 0; i--) {
                if (codeBlockRegex.test(lines[i])) {
                    codeBlockLine = i;
                    break;
                }
            }
            if (codeBlockLine !== -1) {
                insertLineIndex = codeBlockLine; // Insert before code block
                // Find last non-empty line before code block
                while (insertLineIndex > 0 && lines[insertLineIndex - 1].trim() === '') {
                    insertLineIndex--;
                }
            } else {
                 // If no code block, find last definition or just append
                let lastDefLine = -1;
                 for(let i = lines.length -1; i >= 0; i--) {
                    if (/^\s*\[\^.+?\]:/.test(lines[i])) {
                        lastDefLine = i;
                        break;
                    }
                 }
                 if (lastDefLine !== -1) {
                    insertLineIndex = lastDefLine + 1; // Insert after last definition
                 }
                 // Ensure separation
                 while (insertLineIndex > 0 && lines[insertLineIndex - 1].trim() === '') {
                    insertLineIndex--;
                 }
            }

            const separator = (insertLineIndex > 0 && lines[insertLineIndex-1]?.trim() !== '') ? "\n\n" : "";
            lines.splice(insertLineIndex, 0, separator + footnoteDefText);
            cueContent = lines.join('\n').replace(/\n{3,}/g, '\n\n'); // Normalize newlines

			await this.app.vault.modify(cueFile, cueContent);
			new Notice(`Cue ${footnoteRef} added to ${cueFile.basename}.`);

            // 4. Trigger S->C sync to ensure Cue note is fully updated/formatted
            // Use timeout to allow source editor changes to settle before sync reads it
            setTimeout(() => {
                console.log(`[GenerateCue] Triggering S->C sync after adding ${footnoteRef}`);
                this.syncSourceToCue(sourceFile).catch(err => {
                    console.error("Error during post-generateCue sync:", err);
                    new Notice("Sync after Cue generation failed. Manual sync might be needed.");
                });
            }, 300); // Short delay

            // 5. Refresh Cue pane if open and in preview mode
            if (this.activeCornellLeaves.left && this.activeCornellLeaves.left.view instanceof MarkdownView && this.activeCornellLeaves.left.view.file === cueFile) {
                const cueView = this.activeCornellLeaves.left.view;
                if (cueView.getMode() === 'preview') {
                     console.log("Refreshing Cue pane preview after generation.");
                     // Re-setting state forces preview refresh
                     await this.setMarkdownViewMode(cueView, 'preview');
                }
            }

		} catch (error) {
			console.error("Failed to generate Cue:", error);
			new Notice(`Error generating Cue. ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}


	// --- Synchronization Logic (From main.ts その2, adapted) ---

    /**
     * Source -> Cue Sync: Updates the Cue note based on definitions in the Source note.
     */
    syncSourceToCue = async (sourceNoteFile: TFile): Promise<void> => {
        if (this.isSyncing || this.isSwitchingMode) {
            console.log(`[S->C Sync] Skipped for ${sourceNoteFile.basename}: Operation already in progress.`);
            return;
        }
        if (!this.isSourceNote(sourceNoteFile.path)) {
            console.warn(`[S->C Sync] Invalid call: syncSourceToCue called with non-source note: ${sourceNoteFile.path}`);
            return;
        }

        this.isSyncing = true;
        const sourcePath = sourceNoteFile.path;
        console.log(`[S->C Sync] Starting for ${sourcePath}`);
        let mapNeedsSave = false;
        let cueNoteUpdated = false;

        try {
            const sourceContent = await this.app.vault.cachedRead(sourceNoteFile);
            const { definitions: sourceDefs, references: sourceRefs } = this.parseSourceContent(sourceContent); // Get both defs and refs
            const sourceDefinitionsMap = new Map<string, string>(sourceDefs.map(def => [def.ref, def.definition]));

            const cueNotePath = this.getCueNotePath(sourceNoteFile);
            const cueFileAbstract = this.app.vault.getAbstractFileByPath(cueNotePath);
            let cueFileInstance: TFile | null = null;

            if (cueFileAbstract instanceof TFile) {
                cueFileInstance = cueFileAbstract;
            } else {
                // Optionally create the cue note if it doesn't exist during sync
                console.log(`[S->C Sync] Cue note not found for ${sourcePath}. Attempting to create.`);
                cueFileInstance = await this.ensureCueNoteExists(cueNotePath, sourceNoteFile);
                if (!cueFileInstance) {
                    new Notice(`Cue note for "${sourceNoteFile.basename}" not found and could not be created. Skipping S->C sync.`, 7000);
                    console.log(`[S->C Sync] Cue note creation failed for ${sourcePath}. Skipping.`);
                    // Update map if it previously thought cue existed
                    const info = this.getOrCreateNoteInfo(sourceNoteFile);
                    if (info.cuePath !== null) {
                        info.cuePath = null;
                        this.noteInfoMap.set(sourcePath, info);
                        await this.saveData();
                    }
                    this.isSyncing = false; // Release lock before returning
                    await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
                    return;
                } else {
                    new Notice(`Created missing Cue note: ${cueFileInstance.basename}`);
                    mapNeedsSave = true; // Map updated in ensureCueNoteExists
                }
            }

            // Determine final definitions for the Cue note
            const finalCueFootnotes = new Map<string, string>();
            const sourceDefRefs = new Set(sourceDefinitionsMap.keys());

            // Option: Delete definitions from Cue if no references exist in Source
            if (this.settings.deleteDefinitionsOnReferenceDelete) {
                const presentSourceRefKeys = new Set(sourceRefs.map(r => r.ref));
                for (const [ref, def] of sourceDefinitionsMap.entries()) {
                    if (presentSourceRefKeys.has(ref)) {
                        finalCueFootnotes.set(ref, def); // Keep definition if referenced
                    } else {
                        console.log(`[S->C Sync] Excluding def [^${ref}] from Cue (no refs in Source & setting enabled).`);
                    }
                }
            } else {
                // If not deleting based on refs, copy all source definitions
                for(const [ref, def] of sourceDefinitionsMap.entries()) {
                    finalCueFootnotes.set(ref, def);
                }
            }

            // Update Cue note content using the final definitions map
            const updated = await this.updateCueNoteContent(cueFileInstance, sourceNoteFile, finalCueFootnotes);
            if (updated) {
                console.log(`[S->C Sync] Cue note ${cueFileInstance.path} updated.`);
                cueNoteUpdated = true;
            } else {
                // console.log(`[S->C Sync] Cue note ${cueFileInstance.path} content is already up-to-date.`);
            }

            // Update NoteInfoMap (sync time, ensure cuePath is correct)
            const info = this.getOrCreateNoteInfo(sourceNoteFile);
            let infoChanged = false;
            if (info.cuePath !== cueFileInstance.path) {
                info.cuePath = cueFileInstance.path;
                infoChanged = true;
            }
            if (cueNoteUpdated) { // Only update timestamp if content actually changed
                info.lastSyncSourceToCue = Date.now();
                infoChanged = true;
            }
            if (infoChanged || mapNeedsSave) {
                this.noteInfoMap.set(sourcePath, info);
                await this.saveData();
            }

            // Refresh Cue pane if open and in preview mode
            if (cueNoteUpdated && this.activeCornellLeaves.left && this.activeCornellLeaves.left.view instanceof MarkdownView && this.activeCornellLeaves.left.view.file === cueFileInstance) {
                const cueView = this.activeCornellLeaves.left.view;
                 if (cueView.getMode() === 'preview' || this.settings.enforceCuePreview) {
                     console.log("[S->C Sync] Refreshing Cue pane preview.");
                     // Re-setting state forces preview refresh
                     // Ensure it stays in preview if enforced
                     await this.setMarkdownViewMode(cueView, 'preview');
                 }
            }

        } catch (error) {
            console.error(`[S->C Sync] Error during sync for ${sourceNoteFile?.basename}:`, error);
            new Notice(`Error during S->C sync for ${sourceNoteFile.basename}. See console.`);
        } finally {
            await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
            this.isSyncing = false;
            // console.log(`[S->C Sync] Finished for ${sourceNoteFile.path}`);
        }
	}

    /**
     * Cue -> Source Sync: Updates the Source note based on definitions in the Cue note.
     */
    async syncCueToSource(cueNoteFile: TFile): Promise<void> {
        if (this.isSyncing || this.isSwitchingMode) {
            console.log(`[C->S Sync] Skipped for ${cueNoteFile.basename}: Operation already in progress.`);
            return;
        }
        if (!this.isCueNote(cueNoteFile.path)) {
             console.warn(`[C->S Sync] Invalid call: syncCueToSource called with non-cue note: ${cueNoteFile.path}`);
             return;
        }

        this.isSyncing = true;
        let sourceNoteFile: TFile | null = null;
        let sourceNoteUpdated = false;

        console.log(`[C->S Sync] Starting from ${cueNoteFile.path}`);

        try {
            const cueContent = await this.app.vault.cachedRead(cueNoteFile);
            const footnotesFromCue = this.parseFootnotesSimple(cueContent);

            sourceNoteFile = this.getSourceNoteFileFromDerived(cueNoteFile.path);
            if (!sourceNoteFile) {
                new Notice(`Source note not found for ${cueNoteFile.basename}. Cannot sync C->S.`);
                console.error(`[C->S Sync] Source note not found for cue note: ${cueNoteFile.path}`);
                this.isSyncing = false; // Release lock
                return;
            }
            const sourcePath = sourceNoteFile.path;
            console.log(`[C->S Sync] Target Source note: ${sourcePath}`);

            const sourceContent = await this.app.vault.cachedRead(sourceNoteFile);

            // Generate new source content based on Cue definitions and settings
            const newSourceContent = this.updateSourceNoteContentRebuild(
                sourceContent,
                footnotesFromCue,
                this.settings.deleteReferencesOnDefinitionDelete, // Delete source refs if cue def deleted?
                this.settings.moveFootnotesToEnd // Move all defs to end of source?
            );

            if (newSourceContent !== sourceContent) {
                console.log(`[C->S Sync] Source note ${sourcePath} needs update.`);
                await this.app.vault.modify(sourceNoteFile, newSourceContent);
                sourceNoteUpdated = true;
                console.log(`[C->S Sync] Source note ${sourcePath} updated.`);
            } else {
                // console.log(`[C->S Sync] Source note ${sourcePath} content is already up-to-date.`);
            }

            // Update NoteInfoMap
            const info = this.getOrCreateNoteInfo(sourceNoteFile);
            let infoChanged = false;
            if (info.cuePath !== cueNoteFile.path) { // Should generally match, but good to check
                info.cuePath = cueNoteFile.path;
                infoChanged = true;
            }
            if (sourceNoteUpdated) { // Only update timestamp if content actually changed
                info.lastSyncCueToSource = Date.now();
                infoChanged = true;
            }
            if (infoChanged) {
                this.noteInfoMap.set(sourcePath, info);
                await this.saveData();
            }

        } catch (error) {
            console.error(`[C->S Sync] Error during sync from '${cueNoteFile.basename}':`, error);
            new Notice(`Error C->S sync for ${cueNoteFile.basename}. See console.`);
        } finally {
            await sleep(INTERNAL_SETTINGS.syncFlagReleaseDelay);
            this.isSyncing = false;
            // console.log(`[C->S Sync] Finished for ${cueNoteFile.path}`);
        }
    }


	// --- Synchronization & Parsing Helpers (From main.ts その2, adapted) ---

	/** Get or create NoteInfo for a Source note */
	getOrCreateNoteInfo(sourceNoteFile: TFile): CornellNoteInfo {
        const sourcePath = sourceNoteFile.path;
        let info = this.noteInfoMap.get(sourcePath);
        if (!info) {
            const cuePath = this.getCueNotePath(sourceNoteFile);
            const summaryPath = this.getSummaryNotePath(sourceNoteFile);
            const cueFile = this.app.vault.getAbstractFileByPath(cuePath);
            const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);
            info = {
                sourcePath,
                cuePath: cueFile instanceof TFile ? cueFile.path : null,
                summaryPath: summaryFile instanceof TFile ? summaryFile.path : null,
                lastSyncSourceToCue: null,
                lastSyncCueToSource: null
            };
            this.noteInfoMap.set(sourcePath, info);
             console.log(`[Util] Created new NoteInfo entry for ${sourcePath}`);
             // No save here, caller should save if needed
        }
        return info;
    }

	/** Parse Markdown for footnote definitions and references */
	parseSourceContent(content: string): { definitions: ParsedDefinition[], references: ParsedReference[] } {
		const definitions: ParsedDefinition[] = [];
		const references: ParsedReference[] = [];
        const defRegex = /^(\s*)\[\^([^\]]+?)\]:\s*(.*(?:(?:\n(?:\ {4}|\t|\s{2,}).*)*))/gm; // Multiline defs
        const refRegex = /\[\^([^\]]+?)\](?!:)/g; // Refs, excluding defs
        let match;

		while ((match = defRegex.exec(content)) !== null) {
            definitions.push({
                ref: match[2].trim(),
                definition: match[3].replace(/\n(?: {4}|\t|\s{2,})/g, '\n').trim(), // Clean multiline indent
                start: match.index,
                end: match.index + match[0].length,
                fullMatch: match[0]
            });
        }
		while ((match = refRegex.exec(content)) !== null) {
            references.push({
                ref: match[1].trim(),
                start: match.index,
                end: match.index + match[0].length,
                fullMatch: match[0]
            });
        }
		return { definitions, references };
	}

    /** Update Source note content based on Cue definitions (for C->S sync) */
	updateSourceNoteContentRebuild(sourceContent: string, footnotesFromCue: Map<string, string>, deleteReferences: boolean, moveToEnd: boolean): string {
		const { definitions: sourceDefs } = this.parseSourceContent(sourceContent);
        const refsDefinedInCue = new Set(footnotesFromCue.keys());
        const refsToDeleteCompletely = new Set<string>(); // Defs removed from Cue

        // Determine final definitions for Source (Cue is the authority)
        const finalDefinitions = new Map<string, string>();
        sourceDefs.forEach(def => {
            if (refsDefinedInCue.has(def.ref)) {
                finalDefinitions.set(def.ref, footnotesFromCue.get(def.ref)!); // Update with Cue content
            } else {
                refsToDeleteCompletely.add(def.ref); // Mark for full deletion
                console.log(`[C->S Rebuild] Marking def [^${def.ref}] for deletion from Source (not in Cue).`);
            }
        });
        footnotesFromCue.forEach((cueDef, cueRef) => {
            if (!sourceDefs.some(d => d.ref === cueRef)) {
                finalDefinitions.set(cueRef, cueDef); // Add new defs from Cue
                console.log(`[C->S Rebuild] Adding new def [^${cueRef}] to Source from Cue.`);
            }
        });

        // Remove all old definition blocks from source content
        let bodyContent = sourceContent;
        const sortedDefsToRemove = [...sourceDefs].sort((a, b) => b.start - a.start); // Remove from end to start
        for (const def of sortedDefsToRemove) {
            bodyContent = bodyContent.slice(0, def.start) + bodyContent.slice(def.end);
        }
        bodyContent = bodyContent.trimEnd(); // Clean trailing whitespace

        // Optional: Remove references ([^ref]) in the body if their def was removed from Cue
        if (deleteReferences && refsToDeleteCompletely.size > 0) {
             console.log(`[C->S Rebuild] Removing references for deleted definitions: ${Array.from(refsToDeleteCompletely).join(', ')}`);
            const refsToDeleteRegex = new RegExp(`\\[\\^(${Array.from(refsToDeleteCompletely).map(this.escapeRegex).join('|')})\\](?!:)`, 'g');
            bodyContent = bodyContent.replace(refsToDeleteRegex, '');
             new Notice(`Removed references in Source for deleted Cue definitions: ${Array.from(refsToDeleteCompletely).join(', ')}`, 5000);
        }

        // Generate the new, sorted footnote definition block
        let finalDefinitionsText = "";
        if (finalDefinitions.size > 0) {
             finalDefinitionsText = Array.from(finalDefinitions.entries())
                .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })) // Sort numerically/alphabetically
                .map(([ref, def]) => `[^${ref}]: ${def}`)
                .join('\n\n'); // Separate defs by double newline
        }

        // Combine body and definitions
        let newSourceContent = bodyContent;
        if (finalDefinitionsText) {
            if (moveToEnd || !moveToEnd) { // Currently always moves to end, original position logic is complex
                if (!moveToEnd) console.warn("[Cornell Plugin] moveFootnotesToEnd=false is not fully implemented for C->S; footnotes will be appended.");
                // Add definitions at the end, separated by newlines
                newSourceContent += (bodyContent.trim() ? '\n\n' : '') + finalDefinitionsText; // Ensure separation only if body isn't empty
            }
            // else { // Logic to find original position is complex, append for now
            //     newSourceContent += (bodyContent ? '\n\n' : '') + finalDefinitionsText;
            // }
        }
        newSourceContent = newSourceContent.trimEnd() + '\n'; // Ensure single trailing newline

		// Normalize multiple newlines
		return newSourceContent.replace(/\n{3,}/g, '\n\n');
	}

    /** Generate the expected content for a Cue note (header, defs, code block) */
    private generateCueContent(currentContent: string | null, sourceNoteFile: TFile, footnotes: Map<string, string>): string {
        const linkToSource = this.settings.linkToSourceText.replace('{{sourceNote}}', sourceNoteFile.basename);
        let header = "";

        // Extract existing header (content before first definition or code block)
        if (currentContent) {
            const firstDefMatch = currentContent.match(/^(\s*\[\^.+?\]:)/m);
            const firstCbMatch = currentContent.match(new RegExp("^\\s*```" + INTERNAL_SETTINGS.codeBlockProcessorId, "m"));
            let firstElementIdx = currentContent.length;
            if (firstDefMatch?.index !== undefined) firstElementIdx = firstDefMatch.index;
            if (firstCbMatch?.index !== undefined && firstCbMatch.index < firstElementIdx) firstElementIdx = firstCbMatch.index;
            header = currentContent.substring(0, firstElementIdx).trimEnd();
        }

        // Ensure header contains the link to source
        if (!header.includes(linkToSource)) {
             header = header ? `${linkToSource}\n\n${header}` : linkToSource;
        }
        const finalHeader = header ? header + '\n\n' : '';

        // Generate sorted footnote definitions text
        let fnsText = "";
        if (footnotes.size > 0) {
            fnsText = Array.from(footnotes.entries())
                .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }))
                .map(([ref, def]) => `[^${ref}]: ${def}`)
                .join('\n\n');
        }

        // Add the code block if there are footnotes
        const codeBlockSection = footnotes.size > 0
            ? `\n\n\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}\n\`\`\`\n`
            : '\n'; // Add newline even if no block

        // Combine parts and normalize newlines
        const newContent = (finalHeader + fnsText + codeBlockSection).trimEnd() + '\n';
        return newContent.replace(/\n{3,}/g, '\n\n');
    }

	/** Update Cue note content if it differs from the generated expected content */
	async updateCueNoteContent(cueNoteFile: TFile, sourceNoteFile: TFile, footnotes: Map<string, string>): Promise<boolean> {
        let updated = false;
		try {
            const currentContent = await this.app.vault.cachedRead(cueNoteFile);
            const newContent = this.generateCueContent(currentContent, sourceNoteFile, footnotes);

            if (currentContent !== newContent) {
                 console.log(`[Util] Updating content of Cue note: ${cueNoteFile.path}`);
                await this.app.vault.modify(cueNoteFile, newContent);
                updated = true;
            }
		} catch (error) {
            console.error(`[Util] Error updating Cue note content for '${cueNoteFile.basename}':`, error);
        }
        return updated;
	}

    /** Parse content simply for footnote definitions Map<ref, definition> */
	parseFootnotesSimple = (content: string): Map<string, string> => {
        const footnotesMap = new Map<string, string>();
        const regex = /^(\s*)\[\^([^\]]+?)\]:\s*(.*(?:(?:\n(?:\ {4}|\t|\s{2,}).*)*))/gm;
        let match;
        while ((match = regex.exec(content)) !== null) {
            if(match[2]) {
                footnotesMap.set(
                    match[2].trim(),
                    match[3].replace(/\n(?: {4}|\t|\s{2,})/g, '\n').trim() // Clean multiline indent
                );
            }
        }
        return footnotesMap;
    }

	// --- Note Type & Path Helpers (From main.ts その2) ---

    /** Check if a file path represents a Source note */
    isSourceNote(filePath: string): boolean {
        const normPath = normalizePath(filePath);
        return normPath.endsWith('.md') && !this.isCueNote(normPath) && !this.isSummaryNote(normPath);
    }

	/** Check if a file path represents a Cue note */
	isCueNote = (filePath: string): boolean => {
        return filePath ? normalizePath(filePath).endsWith(INTERNAL_SETTINGS.cueNoteSuffix + '.md') : false;
    }

	/** Check if a file path represents a Summary note */
	isSummaryNote = (filePath: string): boolean => {
        return filePath ? normalizePath(filePath).endsWith(INTERNAL_SETTINGS.summaryNoteSuffix + '.md') : false;
    }

	/** Get the expected Cue note path for a Source note */
	getCueNotePath = (sourceFile: TFile): string => {
        const basename = sourceFile.basename;
        const cueFilename = `${basename}${INTERNAL_SETTINGS.cueNoteSuffix}.md`;
        const folderPath = sourceFile.parent?.path ?? '/';
        const finalPath = (folderPath === '/' || folderPath === '') ? cueFilename : `${folderPath}/${cueFilename}`;
        return normalizePath(finalPath);
    }

	/** Get the expected Summary note path for a Source note */
	getSummaryNotePath = (sourceFile: TFile): string => {
        const basename = sourceFile.basename;
        const summaryFilename = `${basename}${INTERNAL_SETTINGS.summaryNoteSuffix}.md`;
        const folderPath = sourceFile.parent?.path ?? '/';
        const finalPath = (folderPath === '/' || folderPath === '') ? summaryFilename : `${folderPath}/${summaryFilename}`;
        return normalizePath(finalPath);
    }

	/** Get the Source TFile corresponding to a Cue or Summary note path */
	getSourceNoteFileFromDerived = (derivedPath: string): TFile | null => {
        const normalizedDerivedPath = normalizePath(derivedPath);

        // Try map first
        for (const info of this.noteInfoMap.values()) {
            if (info.cuePath === normalizedDerivedPath || info.summaryPath === normalizedDerivedPath) {
                const sourceFile = this.app.vault.getAbstractFileByPath(info.sourcePath);
                if (sourceFile instanceof TFile) return sourceFile;
            }
        }

        // Guess from path if not in map
        let sourceBasename: string | null = null;
        const derivedFilename = normalizedDerivedPath.split('/').pop() ?? '';
        const derivedFolder = normalizedDerivedPath.substring(0, normalizedDerivedPath.lastIndexOf('/')) || '/';

        if (this.isCueNote(normalizedDerivedPath)) {
            sourceBasename = derivedFilename.replace(new RegExp(this.escapeRegex(INTERNAL_SETTINGS.cueNoteSuffix + '.md')+'$'), '');
        } else if (this.isSummaryNote(normalizedDerivedPath)) {
            sourceBasename = derivedFilename.replace(new RegExp(this.escapeRegex(INTERNAL_SETTINGS.summaryNoteSuffix + '.md')+'$'), '');
        }

        if (!sourceBasename) return null;

        const sourceFilename = `${sourceBasename}.md`;
        const potentialPath = normalizePath(`${derivedFolder}/${sourceFilename}`); // Assume same folder primarily
        const file = this.app.vault.getAbstractFileByPath(potentialPath);

        if (file instanceof TFile && file.basename === sourceBasename) {
            console.log(`[Util] Guessed Source note for ${derivedPath} -> ${file.path}`);
            // Update map if found via guessing
            this.getOrCreateNoteInfo(file); // Creates entry if missing
            const info = this.noteInfoMap.get(file.path)!;
             if (this.isCueNote(normalizedDerivedPath) && info.cuePath !== normalizedDerivedPath) {
                info.cuePath = normalizedDerivedPath;
                this.noteInfoMap.set(file.path, info);
                this.saveData().catch(e => console.error("[Util] Error saving NoteInfoMap after guessing source:", e));
             }
             if (this.isSummaryNote(normalizedDerivedPath) && info.summaryPath !== normalizedDerivedPath) {
                 info.summaryPath = normalizedDerivedPath;
                 this.noteInfoMap.set(file.path, info);
                 this.saveData().catch(e => console.error("[Util] Error saving NoteInfoMap after guessing source:", e));
             }
            return file;
        }

        // console.warn(`[Util] Source note file not found for derived path: ${derivedPath} (tried path: ${potentialPath})`);
		return null;
	}

    /** Ensure a folder exists, creating it if necessary */
    async ensureFolderExists(folderPath: string): Promise<void> {
        const normalizedPath = normalizePath(folderPath);
        if (!normalizedPath || normalizedPath === '/') return; // No need to create root
        try {
            const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!folder) {
                console.log(`[Util] Creating folder: ${normalizedPath}`);
                await this.app.vault.createFolder(normalizedPath);
            } else if (!(folder instanceof TFolder)) {
                throw new Error(`Path exists but is not a folder: ${normalizedPath}`);
            }
        } catch (e: any) {
            // Ignore "Folder already exists" errors, rethrow others
            if (!(e?.message?.includes('already exists'))) {
                console.error(`[Util] Error ensuring folder exists '${normalizedPath}':`, e);
                throw e;
            }
        }
    }

	/** Escape regex special characters */
	escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /** Open a file in a specific leaf */
    private async openFileInLeaf(leaf: WorkspaceLeaf, file: TFile, active: boolean): Promise<void> {
        await leaf.openFile(file, { active });
        // console.log(`[Util] Opened ${file.path} in leaf ${leaf.id}, active: ${active}`);
    }


    // --- File Creation Helpers (for Arrange Command, etc.) ---

    /** Ensure Cue note exists, create with basic content if not */
    async ensureCueNoteExists(cuePath: string, sourceFile: TFile): Promise<TFile | null> {
        try {
            let abstractFile = this.app.vault.getAbstractFileByPath(cuePath);
            if (abstractFile instanceof TFile) return abstractFile;
            if (abstractFile) throw new Error(`Path exists but is not a file: ${cuePath}`);

            console.log(`[Util] Cue note does not exist, creating: ${cuePath}`);
            const parentFolder = cuePath.substring(0, cuePath.lastIndexOf('/')) || '/';
            await this.ensureFolderExists(parentFolder);

            // Initial content: Link to source + placeholder for sync
            const initialContent = this.generateCueContent(null, sourceFile, new Map()); // Generate with empty footnotes

            abstractFile = await this.app.vault.create(cuePath, initialContent);
            if (!(abstractFile instanceof TFile)) throw new Error(`Failed to create cue note file: ${cuePath}`);

            // Update NoteInfoMap immediately
            const info = this.getOrCreateNoteInfo(sourceFile);
            info.cuePath = abstractFile.path;
            this.noteInfoMap.set(sourceFile.path, info);
            await this.saveData(); // Save map after creation

            return abstractFile;
        } catch (e) {
            console.error(`[Util] Error ensuring Cue note exists at '${cuePath}':`, e);
            new Notice(`Error creating Cue note at ${cuePath}. See console.`);
            return null;
        }
    }

	/** Ensure Summary note exists, create with basic content if not */
	async ensureSummaryNoteExists(summaryPath: string, sourceFile: TFile, cueFile: TFile): Promise<TFile | null> {
        try {
            let abstractFile = this.app.vault.getAbstractFileByPath(summaryPath);
            if (abstractFile instanceof TFile) return abstractFile;
            if (abstractFile) throw new Error(`Path exists but is not a file: ${summaryPath}`);

            console.log(`[Util] Summary note does not exist, creating: ${summaryPath}`);
            const parentFolder = summaryPath.substring(0, summaryPath.lastIndexOf('/')) || '/';
            await this.ensureFolderExists(parentFolder);

            const sourceLink = this.settings.linkToSourceText.replace('{{sourceNote}}', sourceFile.basename);
            const cueLink = this.settings.linkToCueText.replace('{{cueNote}}', cueFile.basename);
            const initialContent = `${sourceLink}\n${cueLink}\n\n## SUMMARY\n\n`; // Use correct section header

            abstractFile = await this.app.vault.create(summaryPath, initialContent);
            if (!(abstractFile instanceof TFile)) throw new Error(`Failed to create summary note file: ${summaryPath}`);

            // Update NoteInfoMap immediately
            const info = this.getOrCreateNoteInfo(sourceFile);
            info.summaryPath = abstractFile.path;
            this.noteInfoMap.set(sourceFile.path, info);
            await this.saveData();

            return abstractFile;
        } catch (e) {
            console.error(`[Util] Error ensuring Summary note exists at '${summaryPath}':`, e);
             new Notice(`Error creating Summary note at ${summaryPath}. See console.`);
            return null;
        }
    }

    // --- Arrange View Command Logic (From main.ts その2, adapted for Cornell layout) ---
    /** Arrange Source, Cue, and Summary notes in the Cornell layout */
    async arrangeCornellNotesView(sourceFile: TFile, sourceLeaf: WorkspaceLeaf): Promise<void> {
        try {
            console.log(`[Arrange] Starting arrange command for ${sourceFile.path}`);
            // Use 'show-all' mode to arrange all three panes
            await this.activateMode('show-all', sourceFile);
            console.log(`[Arrange] Finished arranging view for ${sourceFile.basename} (using Show All mode).`);
            new Notice(`Arranged view for ${sourceFile.basename} (Cue + Source + Summary). Use Alt+1/2/3 to switch modes.`);

        } catch (e) {
            console.error(`[Arrange] Error arranging Cornell notes view for ${sourceFile.basename}:`, e);
            new Notice(`Error arranging view for ${sourceFile.basename}. See console.`);
        }
    }

    // --- Navigation & Highlighting (From main.ts その2, adapted) ---

	/** Navigate from Cue button/def to first reference in Source */
	async navigateToSourceReference(ref: string, cuePath: string): Promise<void> {
        console.log(`[Navigate] Request to navigate to ref [^${ref}] from ${cuePath}`);
        const sourceFile = this.getSourceNoteFileFromDerived(cuePath);
        if (!sourceFile) {
            new Notice(`Source note not found for "${cuePath}". Cannot navigate.`);
            throw new Error(`Source note not found for cue: ${cuePath}`);
        }

        // Find or open the Source note's leaf (prefer existing Cornell center pane)
        let sourceLeaf = (this.activeCornellLeaves.center?.view instanceof MarkdownView && this.activeCornellLeaves.center.view.file === sourceFile) ? this.activeCornellLeaves.center : this.findExistingLeafForFile(sourceFile);

        if (!sourceLeaf || !sourceLeaf.parent) {
            new Notice(`Source note "${sourceFile.basename}" is not open. Opening...`);
            try {
                // Get a leaf, prefer reusing empty ones
                sourceLeaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
                if (!sourceLeaf) throw new Error("Could not get a leaf to open the source note.");
                await this.openFileInLeaf(sourceLeaf, sourceFile, true); // Open and activate
                this.app.workspace.setActiveLeaf(sourceLeaf, {focus: true});
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay * 2); // Wait longer for opening
                if (!(sourceLeaf?.view instanceof MarkdownView)) throw new Error("Opened file is not a Markdown view.");
                console.log(`[Navigate] Opened Source note ${sourceFile.path} in new leaf.`);
            } catch (e) {
                console.error(`[Navigate] Error auto-opening source note ${sourceFile.path}:`, e);
                new Notice(`Failed to open source note "${sourceFile.basename}".`);
                throw e;
            }
        } else {
            // If leaf exists but isn't active, activate it
            if (this.app.workspace.activeLeaf !== sourceLeaf) {
                 console.log(`[Navigate] Activating existing leaf for Source note ${sourceFile.path}`);
                this.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay / 2);
            }
        }

        // Ensure we have a valid view and editor
        if (!sourceLeaf || !(sourceLeaf.view instanceof MarkdownView)) {
            new Notice(`Cannot access source view for "${sourceFile.basename}".`);
            throw new Error("Source view not accessible after opening/finding leaf.");
        }
        const sourceView = sourceLeaf.view;
        // Ensure source mode for reliable searching/scrolling (can switch back after?)
        // const originalMode = sourceView.getMode();
        // await this.setMarkdownViewMode(sourceView, 'source');

        const sourceEditor = sourceView.editor;
        if (!sourceEditor) {
             new Notice(`Cannot access source editor for "${sourceFile.basename}".`);
             throw new Error("Source editor not available.");
        }
        const sourceContent = sourceEditor.getValue();
        const refRegex = new RegExp(`\\[\\^${this.escapeRegex(ref)}\\](?!:)`);
        const match = sourceContent.match(refRegex);

        if (match?.index !== undefined) {
            const matchIndex = match.index;
            const startPos = sourceEditor.offsetToPos(matchIndex);
            const endPos = sourceEditor.offsetToPos(matchIndex + match[0].length);
             console.log(`[Navigate] Found ref [^${ref}] at line ${startPos.line + 1}, char ${startPos.ch}`);
            // Scroll and highlight
            sourceEditor.scrollIntoView({ from: startPos, to: endPos }, true);
            this.clearActiveHighlight(); // Clear previous highlight timer
            sourceEditor.setSelection(startPos, endPos); // Select to highlight
            // Set timer to remove selection highlight
            this.activeHighlightTimeout = setTimeout(() => {
                const currentSelection = sourceEditor.listSelections()[0];
                // Only clear selection if it's still the one we set
                if (currentSelection && this.app.workspace.activeEditor?.editor === sourceEditor &&
                    this.arePositionsEqual(currentSelection.anchor, startPos) &&
                    this.arePositionsEqual(currentSelection.head, endPos)) {
                    sourceEditor.setCursor(startPos); // Move cursor to start of ref
                }
                this.activeHighlightTimeout = null;
            }, INTERNAL_SETTINGS.highlightDuration);
        } else {
             console.log(`[Navigate] Ref [^${ref}] not found in ${sourceFile.path}.`);
            new Notice(`Reference [^${ref}] not found in "${sourceFile.basename}".`);
            // Scroll to top as fallback
            sourceEditor.setCursor({line: 0, ch: 0});
            sourceEditor.scrollTo(0, 0);
        }
        // Focus the editor
        sourceEditor.focus();
        // await this.setMarkdownViewMode(sourceView, originalMode); // Restore original mode? (might cause flicker)
    }

    /** Highlight first reference in Source without stealing focus */
    async highlightFirstSourceReference(ref: string, cuePath: string): Promise<void> {
        console.log(`[Highlight] Request to highlight ref [^${ref}] from ${cuePath}`);
        const sourceFile = this.getSourceNoteFileFromDerived(cuePath);
        if (!sourceFile) {
            new Notice(`Source note not found for "${cuePath}". Cannot highlight.`);
            throw new Error(`Source note not found for cue: ${cuePath}`);
        }

        // Find Source leaf (prefer existing Cornell center pane)
        let sourceLeaf = (this.activeCornellLeaves.center?.view instanceof MarkdownView && this.activeCornellLeaves.center.view.file === sourceFile) ? this.activeCornellLeaves.center : this.findExistingLeafForFile(sourceFile);

        if (!sourceLeaf || !sourceLeaf.parent) {
            // If not open, open it in the background without activating
            new Notice(`Source note "${sourceFile.basename}" is not open. Opening in background...`);
            try {
                sourceLeaf = this.app.workspace.getLeaf('tab'); // New tab leaf
                await this.openFileInLeaf(sourceLeaf, sourceFile, false); // Open without activating
                await sleep(INTERNAL_SETTINGS.uiUpdateDelay);
                if (!(sourceLeaf?.view instanceof MarkdownView)) throw new Error("Opened file is not a Markdown view.");
                 console.log(`[Highlight] Opened Source note ${sourceFile.path} in background leaf.`);
            } catch (e) {
                console.error(`[Highlight] Error opening source note ${sourceFile.path} in background:`, e);
                new Notice(`Failed to open source note "${sourceFile.basename}" for highlighting.`);
                throw e;
            }
        } else {
             // console.log(`[Highlight] Found existing leaf for Source note ${sourceFile.path}`);
        }

        if (!sourceLeaf || !(sourceLeaf.view instanceof MarkdownView)) {
            new Notice(`Cannot access source view for "${sourceFile.basename}".`);
            throw new Error("Source view not accessible.");
        }
        const sourceView = sourceLeaf.view;
        // const originalMode = sourceView.getMode();
        // await this.setMarkdownViewMode(sourceView, 'source'); // Ensure source mode
        const sourceEditor = sourceView.editor;
        if (!sourceEditor) {
            // await this.setMarkdownViewMode(sourceView, originalMode);
            throw new Error("Source editor not available.");
        }

        const sourceContent = sourceEditor.getValue();
        const refRegex = new RegExp(`\\[\\^${this.escapeRegex(ref)}\\](?!:)`);
        const match = sourceContent.match(refRegex);

        if (match?.index !== undefined) {
            const matchIndex = match.index;
            const startPos = sourceEditor.offsetToPos(matchIndex);
            const endPos = sourceEditor.offsetToPos(matchIndex + match[0].length);
             console.log(`[Highlight] Found ref [^${ref}] at line ${startPos.line + 1}, char ${startPos.ch}`);
            // Scroll into view, but don't focus the leaf/editor
            sourceEditor.scrollIntoView({ from: startPos, to: endPos }, true);
            this.clearActiveHighlight();
            sourceEditor.setSelection(startPos, endPos); // Highlight by selecting
            this.activeHighlightTimeout = setTimeout(() => {
                const currentSelection = sourceEditor.listSelections()[0];
                // Clear selection only if it's still the one we set
                if (currentSelection && // No need to check activeEditor here
                    this.arePositionsEqual(currentSelection.anchor, startPos) &&
                    this.arePositionsEqual(currentSelection.head, endPos)) {
                    // Try to restore cursor to where it was before highlighting? Complex.
                    // Just collapse the selection for now.
                     sourceEditor.setCursor(startPos);
                }
                this.activeHighlightTimeout = null;
            }, INTERNAL_SETTINGS.highlightDuration);
        } else {
             console.log(`[Highlight] Ref [^${ref}] not found in ${sourceFile.path}.`);
            new Notice(`Reference [^${ref}] not found in "${sourceFile.basename}".`);
        }
        // await this.setMarkdownViewMode(sourceView, originalMode); // Restore mode
    }

    /** Clear active highlight timer */
    private clearActiveHighlight() {
        if (this.activeHighlightTimeout) {
            clearTimeout(this.activeHighlightTimeout);
            this.activeHighlightTimeout = null;
        }
    }

    /** Compare EditorPosition objects */
    private arePositionsEqual(p1: EditorPosition, p2: EditorPosition): boolean {
        return p1.line === p2.line && p1.ch === p2.ch;
    }


    // --- Batch Processing (From main.ts その2) ---

    /** Sync S->C for all Source notes */
    async processAllNotesSourceToCue(): Promise<void> {
        const allMarkdownFiles = this.app.vault.getMarkdownFiles();
        let processedCount = 0, skippedDerivedCount = 0, errorCount = 0;
        const totalFiles = allMarkdownFiles.length;
        const noticeHandle = new Notice(`Starting S->C sync for ${totalFiles} notes... 0%`, 0); // Indefinite notice

        try {
            const sourceNotesToProcess = allMarkdownFiles.filter(f => this.isSourceNote(f.path));
            const totalSourceNotes = sourceNotesToProcess.length;
             skippedDerivedCount = totalFiles - totalSourceNotes;

            for (let i = 0; i < totalSourceNotes; i++) {
                const file = sourceNotesToProcess[i];
                // Check if already syncing (shouldn't happen here ideally, but safety check)
                if (this.isSyncing) {
                    console.warn(`[Batch Sync S->C] Skipping ${file.path} due to ongoing sync.`);
                    await sleep(INTERNAL_SETTINGS.syncDebounceTime); // Wait before trying next
                    i--; // Retry this file
                    continue;
                }
                try {
                    // syncSourceToCue will handle cue note existence check/creation
                    await this.syncSourceToCue(file);
                    processedCount++;
                } catch (e) {
                    errorCount++;
                    console.error(`[Batch Sync S->C] Error processing ${file.path}:`, e);
                }
                // Update progress notice periodically
                if (processedCount % INTERNAL_SETTINGS.batchSyncUpdateInterval === 0 || i === totalSourceNotes - 1) {
                    const percentage = Math.round(((i + 1) / totalSourceNotes) * 100);
                    noticeHandle.setMessage(`Syncing S->C... ${percentage}% (${processedCount}/${totalSourceNotes} sources synced)`);
                    await sleep(5); // Prevent UI freeze
                }
            }
            const finalMessage = `Sync (S->C) Complete. Synced: ${processedCount}, Errors: ${errorCount}. Total Source Notes: ${totalSourceNotes}.`;
            noticeHandle.setMessage(finalMessage);
            console.log(finalMessage);
            setTimeout(() => noticeHandle.hide(), 7000); // Hide after delay
        } catch (e) {
            console.error('[Batch Sync S->C] Fatal error during batch processing:', e);
            noticeHandle.setMessage(`Fatal error after processing approx ${processedCount} source notes. Check console.`);
            setTimeout(() => noticeHandle.hide(), 10000);
        } finally {
            // Save map after the whole batch operation
            await this.saveData();
            console.log("[Batch Sync S->C] NoteInfoMap saved after batch sync.");
        }
    }


	// --- Custom Code Block Processor (From main.ts その2) ---
    private cornellLinksCodeBlockProcessor = async (
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ) => {
        const currentFilePath = ctx.sourcePath;
        if (!this.isCueNote(currentFilePath)) {
            el.empty();
            return; // Only run in Cue notes
        }
        el.empty(); // Clear placeholder

        try {
            const cueFile = this.app.vault.getAbstractFileByPath(currentFilePath);
            if (!(cueFile instanceof TFile)) throw new Error("Current file is not a valid TFile.");
            const cueContent = await this.app.vault.cachedRead(cueFile);
            const footnotesMap = this.parseFootnotesSimple(cueContent); // Get definitions from this Cue file

            if (footnotesMap.size === 0) {
                el.setText("No footnote definitions found in this Cue note.");
                return;
            }

            const sourceNoteFile = this.getSourceNoteFileFromDerived(currentFilePath);
            if (!sourceNoteFile) {
                el.createEl('div', { text: `Error: Corresponding Source note not found. Cannot create navigation links.`, cls: 'cornell-footnote-error' });
                return;
            }

            // Create container for buttons
            const buttonContainer = el.createDiv({ cls: 'cornell-footnote-links-container' });
            // Sort refs for consistent button order
            const sortedRefs = Array.from(footnotesMap.keys()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }));

            // Create a button for each definition
            for (const footnoteRef of sortedRefs) {
                const button = buttonContainer.createEl('button', {
                    text: `[^${footnoteRef}]`, // Display the reference name
                    cls: 'cornell-footnote-link-button'
                });
                // Add tooltip with definition preview and action hints
                const definitionPreview = (footnotesMap.get(footnoteRef) || "").substring(0, 100) + ( (footnotesMap.get(footnoteRef) || "").length > 100 ? "..." : "");
                button.setAttribute('title', `[^${footnoteRef}]: ${definitionPreview}\nClick: Navigate to first reference in Source\nCtrl/Cmd+Click: Highlight first reference in Source`);

                // Register click event listener for the button
                this.registerDomEvent(button, 'click', async (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const isModifierPressed = event.ctrlKey || event.metaKey;

                    if (footnoteRef) {
                        if (isModifierPressed && this.settings.enableModifierClickHighlight) {
                            // Highlight on Ctrl/Cmd + Click
                            try { await this.highlightFirstSourceReference(footnoteRef, currentFilePath); }
                            catch (e) { console.error(`[LinksCodeBlock] Error highlighting [^${footnoteRef}]:`, e); new Notice(`Error highlighting reference [^${footnoteRef}].`); }
                        } else if (this.settings.enableCueNoteNavigation) {
                            // Navigate on simple Click
                            try { await this.navigateToSourceReference(footnoteRef, currentFilePath); }
                            catch (e) { console.error(`[LinksCodeBlock] Error navigating to [^${footnoteRef}]:`, e); new Notice(`Error navigating to reference [^${footnoteRef}].`); }
                        } else {
                            // Provide feedback if navigation is disabled
                            if (!isModifierPressed) new Notice("Click navigation is disabled in settings.");
                        }
                    }
                });
            }
        } catch (error) {
            console.error(`[LinksCodeBlock] Error processing footnote links for ${currentFilePath}:`, error);
            el.createEl('div', { text: 'Error rendering footnote links. Check console.', cls: 'cornell-footnote-error' });
        }
    }

} // --- End of Plugin Class ---


// --- Settings Tab Class (Combined) ---
class CornellSettingTab extends PluginSettingTab {
	plugin: CornellPlugin;

	constructor(app: App, plugin: CornellPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Cornell Notes System Settings' });
        containerEl.createEl('p', { text: 'Configure layout, synchronization, and interaction for the Cornell Notes system.' });

		// --- Layout Settings (From main.ts その1) ---
		containerEl.createEl('h3', { text: 'Layout & Appearance' });
		new Setting(containerEl)
			.setName('Pane Width Ratio (Left:Center:Right)')
			.setDesc('Set the approximate width ratio for Cue:Source:Summary panes (e.g., 25:50:25). Applied when activating a 2-pane mode (Capture, Recall, Review). Show All (Alt+4) uses equal widths.')
			.addText(text => text
				.setPlaceholder('e.g., 25:50:25')
				.setValue(Object.values(this.plugin.settings.paneWidthRatio).join(':'))
				.onChange(async (value) => {
					const parts = value.split(':').map(p => parseInt(p.trim(), 10));
					if (parts.length === 3 && parts.every(p => !isNaN(p) && p >= 0 && p <= 100) && parts.reduce((a,b) => a+b, 0) > 0 ) {
						const newRatio = { left: parts[0], center: parts[1], right: parts[2] };
                        if (JSON.stringify(newRatio) !== JSON.stringify(this.plugin.settings.paneWidthRatio)) {
                            this.plugin.settings.paneWidthRatio = newRatio;
						    await this.plugin.saveSettings();
                            new Notice("Pane width ratio saved. Applied on next 2-pane mode activation.");
                            // Trigger a re-application if a Cornell mode is currently active (excluding show-all)
                            if (this.plugin.hasActiveSourceFile() && this.plugin.settings.lastMode !== 'show-all') {
                                this.plugin.adjustPaneWidths();
                            }
                        }
					} else {
						new Notice("Invalid format. Use three non-negative numbers separated by colons (e.g., 25:50:25). Sum must be > 0.");
					}
				}));

		new Setting(containerEl)
			.setName('Enforce read-only Cue pane (Preview Mode)')
			.setDesc('Automatically keep the Cue (left) pane in Preview mode. Prevents accidental edits.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enforceCuePreview)
				.onChange(async (value) => {
					this.plugin.settings.enforceCuePreview = value;
					await this.plugin.saveSettings();
                    // If currently in a mode with Cue pane, enforce immediately
                    const leftLeaf = this.plugin.activeCornellLeaves.left;
                    if (value && leftLeaf?.view instanceof MarkdownView) {
                        this.plugin.setMarkdownViewMode(leftLeaf.view, 'preview');
                    }
				}));

        // --- Cue Generation Settings (From main.ts その1) ---
        containerEl.createEl('h3', { text: 'Cue Generation (Alt+C)' });
        new Setting(containerEl)
			.setName('Cue Footnote Prefix')
			.setDesc('Prefix for generated footnote references (e.g., "c" -> [^c1]). Leave empty for standard numbering [^1]. Applied when using "Generate Cue from Selection".')
			.addText(text => text
				.setPlaceholder('e.g., c')
				.setValue(this.plugin.settings.cuePrefix)
				.onChange(async (value) => {
					const sanitizedValue = value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
					this.plugin.settings.cuePrefix = sanitizedValue;
					if (value !== sanitizedValue) {
						new Notice("Prefix sanitized (a-z, A-Z, 0-9, _, -).");
						text.setValue(sanitizedValue); // Update UI
					}
					await this.plugin.saveSettings();
				}));

        // --- Synchronization Settings (From main.ts その2) ---
        containerEl.createEl('h3', { text: 'Synchronization (Source <-> Cue)' });
        containerEl.createEl('p', {
            text: `Synchronizes footnote definitions ([^ref]: ...) between the Source note and its corresponding Cue note. Requires Cue notes to exist (use "Arrange Cornell Notes View" command).`,
            cls:'setting-item-description'
        });

        const syncWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'warning' } });
        syncWarn.createDiv({ cls: 'callout-title', text: 'Caution: Automatic Sync' });
        syncWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'Enabling "Sync on Save" can sometimes lead to unexpected behavior during rapid edits or saves. Manual sync commands offer more control.' });

		new Setting(containerEl)
            .setName('Enable Automatic Sync on Save')
            .setDesc('Automatically trigger sync when a Source or Cue note is saved. Use with caution (see above).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnSave)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnSave = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Auto Sync Enabled (Use Caution!)' : 'Auto Sync Disabled.');
                }));

        // Deletion settings with strong warnings
        const delRefWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'error' } });
        delRefWarn.createDiv({ cls: 'callout-title', text: 'Danger: Automatic Reference Deletion (Cue -> Source)' });
        delRefWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'If enabled, deleting a definition ([^ref]: ...) from the CUE note will delete all matching references ([^ref]) in the SOURCE note during C->S sync. IRREVERSIBLE DATA LOSS risk. Use with extreme caution!' });

        new Setting(containerEl)
            .setName('Auto Delete Source References (Dangerous!)')
            .setDesc('When a definition is deleted from Cue, delete all corresponding [^ref]s from Source during C->S sync.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deleteReferencesOnDefinitionDelete)
                .onChange(async (value) => {
                    this.plugin.settings.deleteReferencesOnDefinitionDelete = value;
                    await this.plugin.saveSettings();
                    if (value) new Notice('DANGER: Auto Reference Deletion (C->S) enabled! Use with extreme caution.', 10000);
                    else new Notice('Auto Reference Deletion (C->S) disabled.');
                }));

        const delDefWarn = containerEl.createDiv({ cls: 'callout', attr: { 'data-callout': 'warning' } });
        delDefWarn.createDiv({ cls: 'callout-title', text: 'Warning: Automatic Definition Deletion (Source -> Cue)' });
        delDefWarn.createDiv({ cls: 'callout-content' }).createEl('p', { text: 'If enabled, deleting *all* references ([^ref]) from the SOURCE note will delete the definition ([^ref]: ...) from the CUE note during S->C sync.' });

        new Setting(containerEl)
            .setName('Auto Delete Cue Definition (on Source Reference Deletion)')
            .setDesc('When all [^ref]s are removed from Source, delete the definition from Cue during S->C sync.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deleteDefinitionsOnReferenceDelete)
                .onChange(async (value) => {
                    this.plugin.settings.deleteDefinitionsOnReferenceDelete = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Auto Definition Deletion (S->C) Enabled.' : 'Auto Definition Deletion (S->C) Disabled.');
                }));

        // Footnote positioning setting
        new Setting(containerEl)
            .setName('Move Footnotes to End of Source Note (on C->S Sync)')
            .setDesc('During CUE -> SOURCE sync, gather all footnote definitions and move them to the end of the Source note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.moveFootnotesToEnd)
                .onChange(async (value) => {
                    this.plugin.settings.moveFootnotesToEnd = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? 'Footnote moving to end (C->S Sync) Enabled.' : 'Footnote moving to end (C->S Sync) Disabled.');
                }));

        // --- Cue Note Interaction Settings (From main.ts その2) ---
        containerEl.createEl('h3', { text: 'Cue Note Interaction (Link Buttons)' });
        containerEl.createEl('p', {
            text: `Configure behavior for the [\^ref] buttons in the Cue note's code block (\`\`\`${INTERNAL_SETTINGS.codeBlockProcessorId}\`\`\`).`,
            cls: 'setting-item-description'
        });

		new Setting(containerEl)
            .setName('Enable Click Navigation')
            .setDesc('Allow clicking buttons in the Cue note code block to navigate to the first reference in the Source note.')
            .addToggle(t => t
                .setValue(this.plugin.settings.enableCueNoteNavigation)
                .onChange(async v => { this.plugin.settings.enableCueNoteNavigation = v; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Enable Ctrl/Cmd + Click Highlight')
            .setDesc('Allow Ctrl/Cmd + clicking buttons to highlight the first reference in the Source note.')
            .addToggle(t => t
                .setValue(this.plugin.settings.enableModifierClickHighlight)
                .onChange(async v => { this.plugin.settings.enableModifierClickHighlight = v; await this.plugin.saveSettings(); }));

        // --- Link Template Settings (From main.ts その2) ---
        containerEl.createEl('h3', { text: 'Link Templates (for Arrange Command & Sync)' });
        containerEl.createEl('p', { text: 'Define links added when creating/syncing Cue/Summary notes.' , cls:'setting-item-description' });

		new Setting(containerEl)
            .setName('Link to Source Template')
            .setDesc('Template for the link in Cue/Summary notes to the Source note. Use {{sourceNote}} for the source note name.')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.linkToSourceText)
                .setValue(this.plugin.settings.linkToSourceText)
                .onChange(async (value) => {
                    this.plugin.settings.linkToSourceText = value || DEFAULT_SETTINGS.linkToSourceText;
                    await this.plugin.saveSettings();
                }));

		new Setting(containerEl)
            .setName('Link to Cue Template')
            .setDesc('Template for the link in Summary notes to the Cue note. Use {{cueNote}} for the cue note name.')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.linkToCueText)
                .setValue(this.plugin.settings.linkToCueText)
                .onChange(async (value) => {
                    this.plugin.settings.linkToCueText = value || DEFAULT_SETTINGS.linkToCueText;
                    await this.plugin.saveSettings();
                }));

        // --- Hotkey / Command Info ---
		containerEl.createEl('h3', { text: 'Commands & Hotkeys' });
		containerEl.createEl('p', { text: 'Configure hotkeys in Obsidian settings (Settings > Hotkeys). Search for "Cornell:" or use the buttons below to copy the command ID.' });

		const createHotkeySetting = (name: string, commandId: string) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(`Command ID: ${commandId}`)
				.addButton(button => button
					.setButtonText("Copy ID")
					.setIcon("clipboard-copy")
					.setTooltip(`Copy "${commandId}"`)
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(commandId);
							new Notice(`Copied Command ID: ${commandId}`);
							new Notice(`Go to Settings > Hotkeys and paste the ID into the search bar.`);
						} catch (err) {
							console.error("Failed to copy command ID:", err);
							new Notice(`Failed to copy. Please copy manually: ${commandId}`);
						}
					}));
		};

		const pluginId = this.plugin.manifest.id;
		if (pluginId) {
            createHotkeySetting('Activate Capture Mode (Alt+1)', `${pluginId}:cornell-capture-mode`);
			createHotkeySetting('Activate Recall Mode (Alt+2)', `${pluginId}:cornell-recall-mode`);
			createHotkeySetting('Activate Review Mode (Alt+3)', `${pluginId}:cornell-review-mode`);
            createHotkeySetting('Activate Show All Mode (Alt+4)', `${pluginId}:cornell-show-all-mode`); // New Command
			createHotkeySetting('Generate Cue from Selection (Alt+C)', `${pluginId}:cornell-generate-cue`);
            createHotkeySetting('Arrange Cornell Notes View', `${pluginId}:arrange-cornell-notes`);
            createHotkeySetting('Manual Sync: Source -> Cue', `${pluginId}:sync-source-to-cue-manually`);
            createHotkeySetting('Manual Sync: Cue -> Source', `${pluginId}:sync-cue-to-source-manually`);
            createHotkeySetting('Sync All Notes (Source -> Cue)', `${pluginId}:sync-all-notes-source-to-cue`);
            createHotkeySetting('Highlight First Reference in Source (from Cue)', `${pluginId}:highlight-first-source-reference`);
		} else {
			console.error("Cornell Plugin: Cannot create hotkey settings - plugin ID missing.");
			containerEl.createEl('p', { text: 'Error: Could not generate hotkey copy buttons (plugin ID missing).', cls: 'setting-item-description mod-warning' });
		}

        // --- Internal Settings Info ---
        containerEl.createEl('h3', { text: 'Internal Configuration (Read-Only)' });
        const internalList = containerEl.createEl('ul');
        internalList.createEl('li', { text: `Cue Note Suffix: ${INTERNAL_SETTINGS.cueNoteSuffix}.md`});
        internalList.createEl('li', { text: `Summary Note Suffix: ${INTERNAL_SETTINGS.summaryNoteSuffix}.md`});
        internalList.createEl('li', { text: `Note Location: Cue/Summary created in same folder as Source.`});
        internalList.createEl('li', { text: `Cue Interaction Code Block ID: ${INTERNAL_SETTINGS.codeBlockProcessorId}`});
        internalList.createEl('li', { text: `Sync Debounce Time: ${INTERNAL_SETTINGS.syncDebounceTime}ms`});
	}
}