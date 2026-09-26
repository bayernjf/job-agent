import { describe, expect, it } from 'vitest';
import {
  IMPROVEMENT_SUGGESTION_CODES,
  composeImprovementSuggestion,
} from './index.js';

describe('composeImprovementSuggestion', () => {
  it('covers every suggestion code in both reader locales', () => {
    for (const code of IMPROVEMENT_SUGGESTION_CODES) {
      const en = composeImprovementSuggestion(code, 'en');
      const zh = composeImprovementSuggestion(code, 'zh-CN');
      expect(en.suggestion.length).toBeGreaterThan(0);
      expect(en.why.length).toBeGreaterThan(0);
      expect(zh.suggestion.length).toBeGreaterThan(0);
      expect(zh.why.length).toBeGreaterThan(0);
    }
  });

  it('renders Chinese copy that is not the English sentence', () => {
    for (const code of IMPROVEMENT_SUGGESTION_CODES) {
      const en = composeImprovementSuggestion(code, 'en');
      const zh = composeImprovementSuggestion(code, 'zh-CN');
      expect(zh.suggestion).not.toBe(en.suggestion);
      expect(zh.why).not.toBe(en.why);
    }
  });
});
