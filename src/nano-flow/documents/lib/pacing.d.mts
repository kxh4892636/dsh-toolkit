/** `git status` 给出的未提交路径；`null` 表示拿不到 git 信号（缺 git / 非仓库 / 超时）。 */
export const collectDirtyPaths: (rootDir: string, domainsRelative: string) => Set<string> | null;

/** 一条 note 里判定要看的那几项。 */
export interface PacingNote {
  readonly status?: unknown;
  readonly description?: unknown;
  readonly body: string;
  readonly file: string;
}

export interface PacingPlan {
  readonly lifecycle?: string;
  readonly notes: readonly PacingNote[];
}

/**
 * 给「仍是 pending 却已经改过正文」的 note 报 warning。
 * 只提醒：不改状态、不影响 `ok`、不写盘。
 */
export const pacingWarnings: (
  ctx: { rootDir: string; warnings: { path: string; rule: string; message: string }[] },
  plan: PacingPlan,
  dirty: Set<string> | null,
) => void;
