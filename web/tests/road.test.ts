import { describe, expect, it } from 'vitest';
import { road } from '../src/lib/format';

describe('road names', () => {
  it('reads TxDOT route codes as they are signed', () => {
    expect(road('IH0027')).toBe('I-27');
    expect(road('SL0289')).toBe('Loop 289');
    expect(road('US0062')).toBe('US 62');
    expect(road('FM2255')).toBe('FM 2255');
    expect(road('BU0084E')).toBe('Bus. US 84E');
  });
  it('writes city streets as on a street sign and marks a missing name', () => {
    expect(road('SLIDE RD')).toBe('Slide Rd');
    expect(road('82ND ST')).toBe('82nd St');
    expect(road(null)).toBe('–');
  });
});
