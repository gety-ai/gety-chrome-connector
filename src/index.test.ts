import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import {
	bookmarkDocId,
	type BookmarkEntry,
	buildBookmarkDoc,
	buildHistoryDoc,
	computeDeletes,
	defaultChromeProfileDir,
	discoverChromeProfileDirs,
	flattenBookmarks,
	historyCutoffWebkitMicros,
	historyDocId,
	historyRangeToMaxAgeDays,
	isWebUrl,
	normalizeProfileScope,
	parseWebkitTimestamp,
	sha1Hex,
	webkitMicrosToRfc3339,
} from './index.ts';

const WEBKIT_UNIX_EPOCH = 11644473600000000n;

Deno.test('webkitMicrosToRfc3339 converts the Unix epoch and rejects non-positive', () => {
	assert.equal(
		webkitMicrosToRfc3339(WEBKIT_UNIX_EPOCH),
		'1970-01-01T00:00:00.000Z',
	);
	// A known visit captured from a real profile.
	assert.equal(
		webkitMicrosToRfc3339(13425461860083487n),
		'2026-06-09T06:57:40.083Z',
	);
	assert.equal(webkitMicrosToRfc3339(0n), null);
	assert.equal(webkitMicrosToRfc3339(-5n), null);
});

Deno.test('parseWebkitTimestamp handles strings, empties, and junk', () => {
	assert.equal(parseWebkitTimestamp('13377617858724128'), 13377617858724128n);
	assert.equal(parseWebkitTimestamp(''), null);
	assert.equal(parseWebkitTimestamp('0'), null);
	assert.equal(parseWebkitTimestamp(undefined), null);
	assert.equal(parseWebkitTimestamp(null), null);
	assert.equal(parseWebkitTimestamp('not-a-number'), null);
});

Deno.test('isWebUrl only accepts http(s)', () => {
	assert.equal(isWebUrl('https://example.com/'), true);
	assert.equal(isWebUrl('http://example.com/'), true);
	assert.equal(isWebUrl('chrome://bookmarks/'), false);
	assert.equal(isWebUrl('file:///etc/hosts'), false);
	assert.equal(isWebUrl(''), false);
});

Deno.test('defaultChromeProfileDir resolves per-OS paths', () => {
	const home = '/home/tester';
	assert.equal(
		defaultChromeProfileDir('linux', home),
		join(home, '.config', 'google-chrome', 'Default'),
	);
	assert.equal(
		defaultChromeProfileDir('darwin', home),
		join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default'),
	);
	// Windows honors LOCALAPPDATA and falls back to AppData/Local.
	assert.equal(
		defaultChromeProfileDir(
			'win32',
			'C:/Users/me',
			'C:/Users/me/AppData/Local',
		),
		join(
			'C:/Users/me/AppData/Local',
			'Google',
			'Chrome',
			'User Data',
			'Default',
		),
	);
	assert.equal(
		defaultChromeProfileDir('win32', '/home/tester'),
		join(
			'/home/tester',
			'AppData',
			'Local',
			'Google',
			'Chrome',
			'User Data',
			'Default',
		),
	);
});

Deno.test('Chrome profiles are discovered in stable order', async () => {
	const userDataDir = await Deno.makeTempDir({
		prefix: 'gety-chrome-profiles-',
	});
	try {
		for (
			const name of [
				'Default',
				'Profile 2',
				'Profile 10',
				'Profile 1',
				'Guest Profile',
				'System Profile',
			]
		) {
			await Deno.mkdir(join(userDataDir, name));
		}

		assert.deepEqual(
			discoverChromeProfileDirs(userDataDir, 'all').map((path) =>
				basename(path)
			),
			['Default', 'Profile 1', 'Profile 2', 'Profile 10'],
		);
		assert.deepEqual(
			discoverChromeProfileDirs(userDataDir, 'default').map((path) =>
				basename(path)
			),
			['Default'],
		);
		assert.equal(normalizeProfileScope('default'), 'default');
		assert.equal(normalizeProfileScope('all'), 'all');
		assert.equal(normalizeProfileScope('unexpected'), 'all');
	} finally {
		await Deno.remove(userDataDir, { recursive: true });
	}
});

Deno.test('historyRangeToMaxAgeDays maps ranges', () => {
	assert.equal(historyRangeToMaxAgeDays('7d'), 7);
	assert.equal(historyRangeToMaxAgeDays('30d'), 30);
	assert.equal(historyRangeToMaxAgeDays('90d'), 90);
	assert.equal(historyRangeToMaxAgeDays('365d'), 365);
	assert.equal(historyRangeToMaxAgeDays('all'), null);
	// Unknown values fall back to 90 days.
	assert.equal(historyRangeToMaxAgeDays('???'), 90);
});

Deno.test('historyCutoffWebkitMicros respects no-limit and computes a cutoff', () => {
	assert.equal(historyCutoffWebkitMicros(null, 1_000_000), null);
	// 0 days from the Unix epoch == the WebKit Unix-epoch offset.
	assert.equal(historyCutoffWebkitMicros(0, 0), WEBKIT_UNIX_EPOCH);
	// One day earlier than the Unix epoch clamps at 0 (no negative WebKit time).
	assert.equal(
		historyCutoffWebkitMicros(1, 0),
		11644473600000000n - 86_400_000n * 1000n,
	);
});

Deno.test('flattenBookmarks builds folder breadcrumbs and stable ids', () => {
	const tree = {
		roots: {
			bookmark_bar: {
				type: 'folder',
				name: 'Bookmarks bar',
				children: [
					{
						type: 'url',
						name: 'Example',
						url: 'https://example.com/',
						guid: 'guid-1',
						date_added: '13377617858724128',
					},
					{
						type: 'folder',
						name: 'design',
						children: [
							{
								type: 'url',
								name: 'Color',
								url: 'https://color.example/',
								guid: 'guid-2',
								date_added: '13377617858724128',
								date_modified: '13377617858724200',
							},
						],
					},
				],
			},
			other: { type: 'folder', name: 'Other bookmarks', children: [] },
		},
	};

	const entries = flattenBookmarks(tree);
	assert.equal(entries.length, 2);

	const top = entries.find((e) => e.guid === 'guid-1')!;
	assert.equal(top.folder, 'Bookmarks bar');
	assert.equal(top.url, 'https://example.com/');

	const nested = entries.find((e) => e.guid === 'guid-2')!;
	assert.equal(nested.folder, 'Bookmarks bar / design');
	assert.equal(nested.dateModified, 13377617858724200n);
});

Deno.test('flattenBookmarks tolerates missing/garbage input', () => {
	assert.deepEqual(flattenBookmarks(null), []);
	assert.deepEqual(flattenBookmarks({}), []);
	assert.deepEqual(flattenBookmarks({ roots: 5 }), []);
});

Deno.test('buildBookmarkDoc emits a linkable web doc', () => {
	const entry: BookmarkEntry = {
		guid: 'g1',
		name: 'Example',
		url: 'https://example.com/',
		folder: 'Bookmarks bar / design',
		dateAdded: WEBKIT_UNIX_EPOCH,
		dateModified: null,
	};
	const doc = buildBookmarkDoc(entry);
	assert.equal(doc.id, 'chrome:bookmark:g1');
	assert.equal(doc.doc_type, 'chrome:bookmark');
	assert.equal(doc.content_format, 'plaintext');
	assert.equal(doc.doc_updated_at, '1970-01-01T00:00:00.000Z');
	const meta = doc.metadata as Record<string, unknown>;
	assert.equal(meta.url, 'https://example.com/');
	assert.equal(meta.folder, 'Bookmarks bar / design');
	assert.equal(meta.created_at, '1970-01-01T00:00:00.000Z');
	assert.equal(meta.profile, 'Default');
	assert.equal((doc.content ?? '').split('\n')[0], 'Example');
});

Deno.test('profile-specific bookmark docs are isolated and labeled', () => {
	const doc = buildBookmarkDoc({
		guid: 'same-guid',
		name: 'Example',
		url: 'https://example.com/',
		folder: '',
		dateAdded: null,
		dateModified: null,
	}, 'Profile 1');
	assert.equal(doc.id, 'chrome:profile:Profile_1:bookmark:same-guid');
	assert.match(doc.content ?? '', /Profile: Profile 1/);
	assert.equal((doc.metadata as Record<string, unknown>).profile, 'Profile 1');
});

Deno.test('buildBookmarkDoc omits url metadata for non-web bookmarks', () => {
	const doc = buildBookmarkDoc({
		guid: 'g2',
		name: 'Bookmarks',
		url: 'chrome://bookmarks/',
		folder: 'Bookmarks bar',
		dateAdded: null,
		dateModified: null,
	});
	const meta = doc.metadata as Record<string, unknown>;
	assert.equal(meta.url, undefined);
	assert.equal(doc.title, 'Bookmarks');
});

Deno.test('buildHistoryDoc hashes the url into a stable id', () => {
	const doc = buildHistoryDoc({
		url: 'https://example.com/page',
		title: 'A Page',
		visitCount: 7,
		lastVisit: WEBKIT_UNIX_EPOCH,
	});
	assert.equal(doc.id, `chrome:history:${sha1Hex('https://example.com/page')}`);
	assert.equal(doc.doc_type, 'chrome:history');
	assert.equal(doc.doc_updated_at, '1970-01-01T00:00:00.000Z');
	const meta = doc.metadata as Record<string, unknown>;
	assert.equal(meta.url, 'https://example.com/page');
	assert.equal(meta.visit_count, 7);
	assert.equal(meta.profile, 'Default');
});

Deno.test('profile-specific history docs use a separate stable id', () => {
	const url = 'https://example.com/page';
	const doc = buildHistoryDoc({
		url,
		title: 'A Page',
		visitCount: 7,
		lastVisit: WEBKIT_UNIX_EPOCH,
	}, 'Profile 1');
	assert.equal(doc.id, `chrome:profile:Profile_1:history:${sha1Hex(url)}`);
	assert.match(doc.content ?? '', /Profile: Profile 1/);
	assert.equal((doc.metadata as Record<string, unknown>).profile, 'Profile 1');
});

Deno.test('buildHistoryDoc falls back to url when title is blank', () => {
	const doc = buildHistoryDoc({
		url: 'https://example.com/x',
		title: '   ',
		visitCount: 1,
		lastVisit: WEBKIT_UNIX_EPOCH,
	});
	assert.equal(doc.title, 'https://example.com/x');
});

Deno.test('computeDeletes returns ids no longer present', () => {
	assert.deepEqual(
		computeDeletes(['a', 'b', 'c'], new Set(['a', 'c'])),
		['b'],
	);
	assert.deepEqual(computeDeletes(undefined, new Set(['a'])), []);
	assert.deepEqual(computeDeletes(['a'], new Set(['a'])), []);
});

Deno.test('doc id helpers are stable', () => {
	assert.equal(bookmarkDocId('xyz'), 'chrome:bookmark:xyz');
	assert.equal(
		historyDocId('https://x/'),
		`chrome:history:${sha1Hex('https://x/')}`,
	);
	assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
