/**
 * 声明核验层的规则版本。
 *
 * 与画像的 `RULE_VERSION` **完全解耦**（design-claim-verification §5）：核验是画像之上的一层，
 * 它既不返回 AbilityProfile 也不参与画像规则版本。同一版本必须对应同一套输出，否则
 * 缓存与分享链接失去可复现性——这也是为什么改规则要先把 expectations 用测试钉住再升版本号。
 */
export const CLAIM_RULE_VERSION = '0.1';
