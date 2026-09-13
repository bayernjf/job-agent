export { stripHtml, collapseWhitespace, decodeEntities, truncateText } from './html.js';
export { parseSalaryText, nullifyZero, type SalaryRange } from './salary.js';
export { epochToIso, textToIso, toPostedIso } from './date.js';
export { inferRemote, workplaceTypeToRemote } from './remote.js';
export {
  canonicalizeUrl,
  normalizeSegment,
  normalizeCompanyName,
  makeNormalizedKey,
} from './dedupe-key.js';
