import type { ProfileBudget } from './types.js';

/**
 * 单画像调用预算追踪（技术选型 6.7 工程要求）。
 * GraphQL 按"点"计费（x-ratelimit-cost 头），REST 按次数计费；
 * 超限后 collector 停止继续采集并标注缺失，禁止静默降级。
 */
export class BudgetTracker {
  private points = 0;
  private calls = 0;

  constructor(private readonly limit: ProfileBudget) {}

  get used(): { graphqlPoints: number; restCalls: number } {
    return { graphqlPoints: this.points, restCalls: this.calls };
  }

  get exhausted(): boolean {
    return this.points >= this.limit.graphqlPoints || this.calls >= this.limit.restCalls;
  }

  recordGraphql(points: number): void {
    this.points += Math.max(0, points);
  }

  recordRest(): void {
    this.calls += 1;
  }

  remaining(): { graphqlPoints: number; restCalls: number } {
    return {
      graphqlPoints: Math.max(0, this.limit.graphqlPoints - this.points),
      restCalls: Math.max(0, this.limit.restCalls - this.calls),
    };
  }
}
