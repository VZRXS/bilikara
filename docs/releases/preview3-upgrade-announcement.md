# Preview 3 升级公告草稿

**待发布审核。** 此文件没有接入 `announcements/index.json`，不产生客户端公告或线上上传。用户确认开发包后，再决定发布日期、唯一公告 ID、覆盖平台与通知有效期，并用现有 Rust 校验器检查正式清单。

旧客户端不一定具备公告板；发布时同时放在 Release 页面，不能只靠软件内公告传达迁移方法。限时升级提醒与 Preview 3 版本说明可分别发布：版本公告只自动展示给已安装对应版本的用户。

## 中文

### 升级 Preview 3：请使用完整包并保留数据

从 v0.7.2、v0.8.0-preview.1 或 preview.2 升级，请下载对应系统与 CPU 的完整包。更早版本使用旧后端，Preview 2 的旧更新器也存在过渡限制；请不要依赖此次应用内升级，不要只替换 exe。

1. 关闭 Bilikara，等待后台进程退出，备份旧安装与数据目录。
2. 将新包解压到新目录，保持完整结构。
3. **Windows Preview 2**：首次启动前，把旧安装的整个 `runtime` 文件夹复制到新安装，与 `bilikara-desktop.exe` 同级。
4. **v0.7.2 / Preview 1**：旧格式需要只读导入到新的原生数据目录，仅复制旧 `runtime` 不够。按升级指南选择实际旧数据源，不与新目录合并。
5. **macOS Preview 2**：替换完整 `bilikara-desktop.app`，保留 `~/Library/Application Support/bilikara/` 和自定义数据根；不要将 `runtime` 复制进 App。更早版本按指南导入旧记录。

打开后核对版本、用户、队列、历史、指定场次导出和设置。要接着唱请选择「继续上一场」；关闭提示或等倒计时结束会开新一场。确认数据与播放正常后再处理旧安装。自定义数据路径需要保持或指向已迁移的目录。

[下载完整包](https://github.com/VZRXS/bilikara/releases) · [升级步骤](https://github.com/VZRXS/bilikara/blob/work/v0.8.0/docs/upgrading.md) · [快速说明](https://github.com/VZRXS/bilikara/blob/work/v0.8.0/docs/quick-start.md)

## English

### Upgrading to Preview 3: use the full package and keep your data

For v0.7.2, v0.8.0-preview.1 or preview.2, download the full package for your OS and CPU. Earlier versions use the old backend; Preview 2 also has a transitional updater limitation. Use manual replacement for this upgrade, rather than replacing an executable alone.

Close Bilikara and wait for its background processes to exit. Back up the old installation and any custom data roots, then extract the new package into a separate directory.

- **Windows Preview 2:** before the first launch, copy the entire old `runtime` folder beside the new `bilikara-desktop.exe`.
- **v0.7.2 / Preview 1:** import old-format records read-only into a new native data root as described in the upgrade guide. Copying `runtime` alone is insufficient; do not merge old and new data.
- **macOS Preview 2:** replace the complete `bilikara-desktop.app`, keeping `~/Library/Application Support/bilikara/` and custom data roots. Do not copy `runtime` inside the app. Earlier records require explicit import.

Check the version, users, queue, history, archived-session export and settings before removing your backup. Select Continue Previous Session to keep singing; dismissing the prompt or letting its countdown finish starts a new session. Preserve custom path overrides or point them to the migrated location.

[Full packages](https://github.com/VZRXS/bilikara/releases) · [Upgrade guide](https://github.com/VZRXS/bilikara/blob/work/v0.8.0/docs/upgrading.md)

## 日本語

### Preview 3 への更新：完全パッケージとデータの保管

v0.7.2、v0.8.0-preview.1、preview.2 からは、OS と CPU に合う完全パッケージをダウンロードしてください。旧バージョンのバックエンドや Preview 2 の更新処理には移行上の制限があるため、今回は手動更新を行い、実行ファイルだけを差し替えないでください。

Bilikara を終了し、バックグラウンドプロセスの終了を待ちます。旧インストールと独自のデータ保存先をバックアップし、新しいパッケージを別のフォルダーに展開してください。

- **Windows Preview 2**：初回起動前に、旧フォルダーの `runtime` 全体を、新しい `bilikara-desktop.exe` と同じ階層にコピーします。
- **v0.7.2 / Preview 1**：旧形式の記録は、新しいネイティブ保存先へ読み取り専用で取り込みます。`runtime` のコピーだけでは不十分です。新旧のデータを混ぜず、更新ガイドに従ってください。
- **macOS Preview 2**：完全な `bilikara-desktop.app` を置き換え、`~/Library/Application Support/bilikara/` と独自の保存先を残します。App 内に `runtime` をコピーしないでください。より古い記録には明示的な取り込みが必要です。

バージョン、ユーザー、待ち順、履歴、過去の回ごとのエクスポート、設定を確認してから旧フォルダーを整理してください。続けて歌う場合は「前回を続ける」を選びます。通知を閉じるかカウントダウンが終了すると新しい回になります。独自のパス設定も維持するか、移行先へ変更してください。

[完全パッケージ](https://github.com/VZRXS/bilikara/releases) · [更新ガイド](https://github.com/VZRXS/bilikara/blob/work/v0.8.0/docs/upgrading.md)
