import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetId, monthMatches, matchRows, todayTab, a1 } from '../src/sheets.js';

describe('parseSheetId', () => {
  test('extracts the id from a full edit URL', () => {
    assert.equal(
      parseSheetId('https://docs.google.com/spreadsheets/d/1AbC-_dEf/edit#gid=0'),
      '1AbC-_dEf',
    );
  });
  test('accepts a bare id unchanged', () => {
    assert.equal(parseSheetId('abc123_-XYZ'), 'abc123_-XYZ');
  });
  test('rejects junk and empties', () => {
    assert.equal(parseSheetId('not a sheet!!'), null);
    assert.equal(parseSheetId(''), null);
    assert.equal(parseSheetId(null), null);
  });
});

describe('monthMatches', () => {
  const july = new Date(2026, 6, 21);
  test('matches the current month + year in the title', () => {
    assert.deepEqual(monthMatches('WIP - JULY 2026 - 20', july), { ok: true, month: 'JULY 2026' });
  });
  test('is case-insensitive', () => {
    assert.equal(monthMatches('wip - july 2026', july).ok, true);
  });
  test("flags the wrong month's file", () => {
    const r = monthMatches('WIP - JULY 2026', new Date(2026, 7, 1));
    assert.equal(r.ok, false);
    assert.equal(r.month, 'AUGUST 2026');
  });
  test('flags a title with no month at all', () => {
    assert.equal(monthMatches('some random sheet', july).ok, false);
  });
});

describe('matchRows', () => {
  // index i in this array is spreadsheet row i+1 (values.get starts at row 1).
  const rows = [
    ['READ ME:'],
    ['Team', "Staff's name", 'will work', 'have done', 'time more', 'need help'],
    ['Admin', 'Dang Thi Hoa (Hana)', 'a', 'b', '', ''],
    ['F45 + Visibl', 'Bui Quang Huy (Alan)', 'work', 'done', '2h', 'nothing'],
    ['F45', 'Nguyen Duy Tan (Tan)', 'x', 'y', '', ''],
    ['Visibl', 'Bui Quang Huy (Bob)', 'p', 'q', '', ''],
  ];

  test('finds a unique full-name match with the right row number', () => {
    const got = matchRows(rows, 'Nguyen Duy Tan');
    assert.equal(got.length, 1);
    assert.equal(got[0].team, 'F45');
    assert.equal(got[0].rowNumber, 5);
    assert.equal(got[0].cols[3], 'y');
  });

  test('matches on the nickname alone', () => {
    const got = matchRows(rows, 'Alan');
    assert.equal(got.length, 1);
    assert.equal(got[0].team, 'F45 + Visibl');
    assert.equal(got[0].rowNumber, 4);
  });

  test('returns every row when the name is ambiguous, carrying distinct teams', () => {
    const got = matchRows(rows, 'Bui Quang Huy');
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((c) => c.team).sort(), ['F45 + Visibl', 'Visibl']);
  });

  test('folds accents so a diacritic name still matches', () => {
    const got = matchRows(rows, 'Nguyễn Duy Tân');
    assert.equal(got.length, 1);
    assert.equal(got[0].rowNumber, 5);
  });

  test('skips header/blank rows and unknown names', () => {
    assert.equal(matchRows(rows, 'Someone Unknown').length, 0);
    assert.equal(matchRows(rows, '').length, 0);
  });
});

describe('todayTab', () => {
  test('picks the tab named for the day of the month', () => {
    assert.equal(todayTab(['19', '20', '21'], new Date(2026, 6, 20)), '20');
  });
  test('matches a zero-padded day', () => {
    assert.equal(todayTab(['04', '05', '06'], new Date(2026, 6, 5)), '05');
  });
  test('falls back to the first tab when no day matches', () => {
    assert.equal(todayTab(['Sheet1', 'Notes'], new Date(2026, 6, 20)), 'Sheet1');
  });
});

describe('a1', () => {
  test('builds a plain range for a simple tab name', () => {
    assert.equal(a1('20', ['C', 'F'], 4), '20!C4:F4');
  });
  test('quotes a tab name with spaces', () => {
    assert.equal(a1('July Week 1', ['C', 'F'], 4), "'July Week 1'!C4:F4");
  });
});
