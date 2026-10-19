import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoursText, normalizeRule, statusAt, summarizeRule } from '../public/shared/hours.js';

test('운영시간 글자 → 요일별 규칙', () => {
  assert.equal(summarizeRule(parseHoursText('평일 09:00-18:00')), '평일 09:00–18:00 · 주말 휴무');
  assert.equal(summarizeRule(parseHoursText('08:00-20:00')), '매일 08:00–20:00');
  assert.equal(summarizeRule(parseHoursText('평일 09:00-18:00, 토 10:00-15:00, 일 휴무')), '평일 09:00–18:00 · 토 10:00–15:00 · 일 휴무');
  assert.equal(summarizeRule(parseHoursText('24시간')), '매일 24시간');
  // 알아들을 수 없거나 하루에 시간대가 둘이면 규칙으로 바꾸지 않는다(메모로 남김)
  assert.equal(parseHoursText('예약제'), null);
  assert.equal(parseHoursText('11:00-14:00, 17:00-19:00'), null);
  assert.equal(normalizeRule({ wd: { open: '09:00', close: '09:00' }, sat: 'closed', sun: 'closed' }), null);
});

test('운영 상태: 운영 전 / 운영 중 / 곧 종료 / 운영 종료 / 휴무 / 자정 넘김', () => {
  const r = parseHoursText('평일 09:00-18:00, 토 10:00-15:00, 일 휴무');
  const at = (s) => statusAt(r, new Date(s)).state;
  assert.equal(at('2026-10-13T08:59'), 'before'); // 화요일
  assert.equal(at('2026-10-13T09:00'), 'open');
  assert.equal(at('2026-10-13T17:31'), 'soon');
  assert.equal(at('2026-10-13T18:00'), 'after');
  assert.equal(at('2026-10-18T12:00'), 'closed'); // 일요일
  assert.equal(statusAt(r, new Date('2026-10-13T12:00'), 'en').label, 'Open now');
  const night = parseHoursText('18:00-02:00');
  assert.equal(statusAt(night, new Date('2026-10-14T01:00')).state, 'open');
  assert.equal(statusAt(night, new Date('2026-10-14T03:00')).state, 'before');
});
