export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type BudgetComplexity = 1 | 2 | 3 | 4 | 5;

/** README §4.1 hard caps per quest. */
export function defaultBudgetCap(complexity: number): number {
  if (!Number.isFinite(complexity)) throw new RangeError(`Invalid complexity: ${complexity}`);
  if (complexity <= 2) return 10_000;
  if (complexity <= 4) return 30_000;
  return 50_000;
}

export class BudgetExceeded extends Error {
  readonly name = "BudgetExceeded";
  constructor(
    readonly cap: number,
    readonly used: number,
    readonly requested: number,
    readonly agentId?: string,
  ) {
    super(
      `Token budget exceeded: used ${used} + requested ${requested} > cap ${cap}` +
        (agentId ? ` (agent ${agentId})` : ""),
    );
  }
}

export class CostCapExceeded extends Error {
  readonly name = "CostCapExceeded";
  constructor(
    readonly costCapUsd: number,
    readonly spentUsd: number,
    readonly agentId?: string,
  ) {
    super(
      `Cost cap exceeded: spent $${spentUsd.toFixed(4)} >= cap $${costCapUsd.toFixed(4)}` +
        (agentId ? ` (agent ${agentId})` : ""),
    );
  }
}

/** Reads MAX_COST_USD_PER_QUEST (default 0.50); invalid values fall back to the default. */
export function costCapFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MAX_COST_USD_PER_QUEST);
  return env.MAX_COST_USD_PER_QUEST?.trim() && Number.isFinite(n) && n > 0 ? n : 0.5;
}

export interface AgentLedgerEntry {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export class BudgetTracker {
  readonly cap: number;
  readonly costCapUsd?: number;
  private _used = 0;
  private _costUsd = 0;
  private readonly ledger = new Map<string, AgentLedgerEntry>();

  constructor(cap: number, costCapUsd?: number) {
    if (!Number.isFinite(cap) || cap <= 0) throw new RangeError(`Invalid cap: ${cap}`);
    if (costCapUsd !== undefined && (!Number.isFinite(costCapUsd) || costCapUsd <= 0))
      throw new RangeError(`Invalid costCapUsd: ${costCapUsd}`);
    this.cap = cap;
    this.costCapUsd = costCapUsd;
  }

  static forComplexity(complexity: number): BudgetTracker {
    return new BudgetTracker(defaultBudgetCap(complexity));
  }

  get used(): number {
    return this._used;
  }

  get costUsd(): number {
    return this._costUsd;
  }

  get costExhausted(): boolean {
    return this.costCapUsd !== undefined && this._costUsd >= this.costCapUsd;
  }

  /** Accounts spent dollars; throws CostCapExceeded once spend reaches the cap. */
  recordCost(costUsd: number, agentId = "lead"): void {
    if (!Number.isFinite(costUsd) || costUsd < 0)
      throw new RangeError("Cost must be a non-negative finite number");
    this._costUsd += costUsd;
    if (this.costExhausted) throw new CostCapExceeded(this.costCapUsd!, this._costUsd, agentId);
  }

  get remaining(): number {
    return Math.max(0, this.cap - this._used);
  }

  /** 1 = full HP, 0 = depleted. */
  get remainingRatio(): number {
    return this.remaining / this.cap;
  }

  get exhausted(): boolean {
    return this._used >= this.cap;
  }

  canSpend(estimate: number): boolean {
    if (!Number.isFinite(estimate) || estimate < 0) return false;
    return this._used + estimate <= this.cap;
  }

  /** Throws BudgetExceeded if the estimate would breach the cap. */
  assertCanSpend(estimate: number, agentId?: string): void {
    if (!this.canSpend(estimate)) {
      throw new BudgetExceeded(this.cap, this._used, estimate, agentId);
    }
  }

  /**
   * Records actual usage (always accounted, since tokens are already spent).
   * Throws BudgetExceeded after recording if the cap is now breached.
   */
  record(usage: TokenUsage, agentId = "lead"): void {
    const { promptTokens, completionTokens } = usage;
    if (![promptTokens, completionTokens].every((n) => Number.isFinite(n) && n >= 0)) {
      throw new RangeError("Usage token counts must be non-negative finite numbers");
    }
    const total = promptTokens + completionTokens;
    const e = this.ledger.get(agentId) ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 0,
    };
    e.promptTokens += promptTokens;
    e.completionTokens += completionTokens;
    e.totalTokens += total;
    e.calls += 1;
    this.ledger.set(agentId, e);
    this._used += total;
    if (this._used > this.cap)
      throw new BudgetExceeded(this.cap, this._used - total, total, agentId);
  }

  agentUsage(agentId: string): AgentLedgerEntry {
    const e = this.ledger.get(agentId);
    return e ? { ...e } : { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  }

  snapshot() {
    return {
      cap: this.cap,
      used: this._used,
      remaining: this.remaining,
      remainingRatio: this.remainingRatio,
      costUsd: this._costUsd,
      costCapUsd: this.costCapUsd,
      agents: Object.fromEntries([...this.ledger].map(([k, v]) => [k, { ...v }])),
    };
  }
}
