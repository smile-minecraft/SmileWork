# SmileWork

SmileWork 是跨代理共用的本機 MCP 伺服器。它透過 stdio 連上 Claude Code、OpenCode、Codex 等宿主，讓同一個專案的工作、證據與知識由同一份資料庫管理。資料保存在 `~/.smilework/`，伺服器本身不呼叫 LLM，也不連網。

## 目前狀態

目前是專案骨架，還不能正式使用：

- CLI 入口與十個子命令的掛載點已建立，子命令本身尚未實作。
- MCP 伺服器、資料庫、工具與匯出器都還沒有實作。
- `@modelcontextprotocol/server` 與 `zod` 已列為依賴，供後續實作使用。

## 開發

需要 Bun 1.3 以上，專案會使用 `bun:sqlite`。

```sh
bun install
bun test
bun run typecheck
bun run build
```

查看 CLI 說明：

```sh
bun run src/cli/index.ts --help
```

安裝後也可以用 `smilework` 執行同一支 CLI。

## 文件

- [文件索引](docs/README.md)

研究、spike 與臨時文件不放在 `docs/`，也不進版控。
