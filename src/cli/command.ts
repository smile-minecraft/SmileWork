export interface Command {
  /** 顯示在 `--help` 清單的一行說明。 */
  readonly description: string;
  /** 執行子命令，回傳程序結束碼。 */
  run(args: readonly string[]): number | Promise<number>;
}
