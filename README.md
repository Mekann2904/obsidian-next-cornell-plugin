```mermaid
flowchart LR
    subgraph "プラグインライフサイクル"
        A1[プラグインロード] --> A2[設定とノート情報読み込み]
        A2 --> A3[ノート情報マップ初期化]
        A3 --> A4[コマンド・イベント登録]
        A4 --> A5[設定タブ追加]
        A5 --> A6["レイアウト復元 (onLayoutReady)"]
        A6 --> A7[プラグイン準備完了]
    end

    subgraph "コマンドフロー"
        A4 --> C1["キャプチャモード(Alt+1)"] --> M1["activateMode('capture')"]
        A4 --> C2["想起モード(Alt+2)"]        --> M2["activateMode('recall')"]
        A4 --> C3["レビュー(Alt+3)"]          --> M3["activateMode('review')"]
        A4 --> C4["全表示(Alt+4)"]            --> M4["activateMode('show-all')"]
        A4 --> C5["Cue生成(Alt+C)"]           --> G1[generateCue]
        A4 --> C6[手動S→C同期]               --> S1[syncSourceToCue]
        A4 --> C7[手動C→S同期]               --> S2[syncCueToSource]
        A4 --> C8[全ノートS→C同期]           --> S3[processAllNotesSourceToCue]
        A4 --> C9[ビュー配置]                --> P1[arrangeCornellNotesView]
        A4 --> C10[参照ハイライト]           --> H1[highlightFirstSourceReference]
    end

    subgraph "モード切替フロー"
        M1 --> M1a[Sourceノート決定]
        M1a --> M1b[前状態クリア]
        M1b --> M1c[Cue/Summaryノート作成]
        M1c --> M1d[初期S→C同期]
        M1d --> M1e[レイアウト確保]
        M1e --> M1f[コンテンツ設定]
        M1f --> M1g[フォーカス＆スクロール]
    end

    subgraph "S→C同期フロー"
        S1 --> S1a[Source読み込み]
        S1a --> S1b[定義解析]
        S1b --> S1c[Cueノート確認/作成]
        S1c --> S1d[Cue内容更新]
        S1d --> S1e[noteInfoMap更新]
        S1e --> S1f[Cueプレビュー更新]
    end

    subgraph "C→S同期フロー"
        S2 --> S2a[Cue読み込み]
        S2a --> S2b[定義解析]
        S2b --> S2c[Source取得]
        S2c --> S2d[Source内容更新]
        S2d --> S2e[noteInfoMap更新]
    end

    subgraph "Cue生成フロー"
        G1 --> G1a[選択検証]
        G1a --> G1b[参照挿入]
        G1b --> G1c[定義追加]
        G1c --> G1d[S→C同期トリガ]
        G1d --> G1e[Cueプレビュー更新]
    end


```# obsidian-next-cornell-plugin
# obsidian-next-cornell-plugin
