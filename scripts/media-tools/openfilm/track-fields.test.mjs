// Guard for the OpenFilm patch (keep-track-fields): every field a track has in film.html, not only its clips, survives
// Studio merging an agent's write of film.html over the person's edits. Runs against an installed openfilm package:
//   OPENFILM_PACKAGE=<folder with src/ and studio/> node --test track-fields.test.mjs
// Each field of TRACK_FIELDS but `clips` needs a sample below, so a field added upstream fails here until it is covered.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const pkg = process.env.OPENFILM_PACKAGE
if (!pkg) throw new Error('Set OPENFILM_PACKAGE to the openfilm package folder (it has src/ and studio/).')
const scratch = mkdtempSync(join(tmpdir(), 'apex-openfilm-tracks-'))
Object.assign(process.env, {
  OPENFILM_HOME: join(scratch, 'home'),
  OPENFILM_LIBRARY: join(scratch, 'library'),
  OPENFILM_TRASH_DIR: join(scratch, 'trash'),
  OPENFILM_NO_BROWSER: '1',
  OPENFILM_NO_UPDATE_CHECK: '1'
})
mkdirSync(process.env.OPENFILM_TRASH_DIR)
after(() => rmSync(scratch, { recursive: true, force: true }))

const load = rel => import(pathToFileURL(join(resolve(pkg), rel)).href)
const filmDoc = await load('src/film-doc.mjs')
const { changeProjectFilm, editProjectFilm, settleProjectFilm } = await load('studio/server/film.mjs')
const personEdits = await load('studio/server/person-edits.mjs')
const { mergeWrite } = await load('studio/server/person-merge.mjs')
const { filmHtml, readFilmFile } = filmDoc

const CAPTIONS = { src: 'captions/zh.vtt', kind: 'captions', srclang: 'zh', label: '中文' }
/** Each track field but its clips: a value to have, and another to change it to (false: not set). */
const SAMPLES = {
  locked: [true, false],
  hidden: [true, false],
  muted: [true, false],
  attrs: [{ class: 'b-roll', 'data-role': 'cutaways' }, { class: 'a-roll' }],
  captions: [CAPTIONS, { ...CAPTIONS, label: '简体中文' }]
}
const FIELDS = Object.keys(SAMPLES)

const page = (id, extra = {}) => ({ id, src: `${id}.html`, box: { x: 0, y: 0, w: 640, h: 360 }, ...extra })
const setField = (track, f, v) => {
  if (v === false || v === undefined) delete track[f]
  else track[f] = structuredClone(v)
}
/**
 * The film the agent wrote first: clips a, b on one track; field `f` set on a track of clip c and on the caption track
 * (captions: on the caption track alone, the only track that has one).
 */
function start(f) {
  const caption = { clips: [], captions: structuredClone(CAPTIONS) }
  const tracks = [{ clips: [page('a', { at: 0 }), page('b', { at: 4 })] }]
  if (f !== 'captions') {
    const c = { clips: [page('c', { at: 0 })] }
    setField(c, f, SAMPLES[f][0])
    setField(caption, f, SAMPLES[f][0])
    tracks.push(c)
  }
  tracks.push(caption)
  return { stage: { w: 1920, h: 1080 }, tracks }
}
/** The tracks that hold field `f` in `film` (null where one is gone). */
const holders = (film, f) => [
  ...(f === 'captions' ? [] : [film.tracks.find(t => t.clips.some(c => c.id === 'c')) ?? null]),
  film.tracks.find(t => !t.clips.length && t.captions?.src === CAPTIONS.src) ?? null
]
const read = root => readFilmFile(readFileSync(join(root, 'film.html'), 'utf8')).value
const write = (root, film) => writeFileSync(join(root, 'film.html'), filmHtml(film))
const clip = (film, id) => film.tracks.flatMap(t => t.clips).find(c => c.id === id)
/** A project folder with `film` as the agent wrote it, Studio having read it. */
async function project(film) {
  const root = mkdtempSync(join(scratch, 'p-'))
  mkdirSync(join(root, 'captions'))
  writeFileSync(join(root, 'captions', 'zh.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\n<c.k>你好</c>\n')
  write(root, film)
  await settleProjectFilm(root)
  return root
}
/** The person's edit elsewhere: clip a moved to 2 s. */
const personMovesA = root => editProjectFilm(root, null, [{ op: 'set', clip: 'a', field: 'at', value: 2 }])
/** The agent's copy `film` with its own edit: clip b wider. */
const agentWidensB = film => {
  clip(film, 'b').box.w = 1280
  return film
}
/** Field `f` on each of the tracks that hold it, as `want` (false: not set); the person's and the agent's edits there. */
function expectField(root, f, want) {
  const film = read(root)
  for (const track of holders(film, f)) {
    assert.ok(track, `the track holding ${f} is gone: ${readFileSync(join(root, 'film.html'), 'utf8')}`)
    if (want === false) assert.equal(track[f], undefined, `${f} is still set`)
    else assert.deepEqual(track[f], want)
  }
}

test('every field a track has but its clips has a sample here', () => {
  assert.ok(Array.isArray(filmDoc.TRACK_FIELDS), 'film-doc.mjs exports TRACK_FIELDS (the patch adds the export)')
  assert.deepEqual(filmDoc.TRACK_FIELDS.filter(f => f !== 'clips').sort(), [...FIELDS].sort())
})

for (const f of FIELDS) {
  test(`${f}: kept when the agent writes over the person's edit from its older copy`, async () => {
    const root = await project(start(f))
    await personMovesA(root)
    write(root, agentWidensB(start(f)))
    await settleProjectFilm(root)
    assert.equal(clip(read(root), 'a').at, 2)
    assert.equal(clip(read(root), 'b').box.w, 1280)
    expectField(root, f, SAMPLES[f][0])
  })

  test(`${f}: the agent's change stands beside the person's edit`, async () => {
    const root = await project(start(f))
    await personMovesA(root)
    const theirs = agentWidensB(start(f))
    for (const track of holders(theirs, f)) setField(track, f, SAMPLES[f][1])
    write(root, theirs)
    await settleProjectFilm(root)
    assert.equal(clip(read(root), 'a').at, 2)
    expectField(root, f, SAMPLES[f][1])
  })

  test(`${f}: the person's change stands over the agent's older copy`, async () => {
    const root = await project(start(f))
    await changeProjectFilm(root, value => {
      for (const track of holders(value, f)) setField(track, f, SAMPLES[f][1])
      return { value }
    })
    write(root, agentWidensB(start(f)))
    await settleProjectFilm(root)
    assert.equal(clip(read(root), 'b').box.w, 1280)
    expectField(root, f, SAMPLES[f][1])
  })

  test(`${f}: a caption track the person changed stays whole when the agent's write drops it`, async () => {
    const root = await project(start(f))
    const other = f === 'locked' ? 'muted' : 'locked'
    await changeProjectFilm(root, value => {
      const caption = holders(value, 'captions')[0]
      setField(caption, other, !caption[other])
      return { value }
    })
    const theirs = agentWidensB(start(f))
    theirs.tracks = theirs.tracks.filter(t => t.clips.length)
    write(root, theirs)
    await settleProjectFilm(root)
    const caption = holders(read(root), 'captions')[0]
    assert.ok(caption, 'the caption track is gone')
    assert.deepEqual(caption.captions, f === 'captions' ? SAMPLES.captions[0] : CAPTIONS)
    if (f !== 'captions') assert.deepEqual(caption[f], other === f ? undefined : SAMPLES[f][0])
    assert.equal(Boolean(caption[other]), !start(f).tracks.at(-1)[other])
    assert.match(personEdits.noteFor(root, 'pid:1')?.line ?? '', /the caption track captions\/zh\.vtt/)
  })

  test(`${f}: kept in the person's film when the merge fails`, async () => {
    const root = await project(start(f))
    await personMovesA(root)
    personEdits.configure({
      merge: () => {
        throw new Error('merge failed on purpose')
      }
    })
    try {
      write(root, agentWidensB(start(f)))
      await settleProjectFilm(root)
    } finally {
      personEdits.configure({ merge: mergeWrite })
    }
    assert.equal(clip(read(root), 'a').at, 2)
    expectField(root, f, SAMPLES[f][0])
  })
}

test('a caption track the person added stays over an older copy without it', async () => {
  const film = start('attrs')
  film.tracks.pop()
  const root = await project(film)
  await editProjectFilm(root, null, [{ op: 'captions', at: 0, captions: CAPTIONS }])
  write(root, agentWidensB(structuredClone(film)))
  await settleProjectFilm(root)
  assert.equal(clip(read(root), 'b').box.w, 1280)
  assert.deepEqual(holders(read(root), 'captions')[0]?.captions, CAPTIONS)
})

test('a caption track the person removed stays removed over an older copy with it', async () => {
  const root = await project(start('attrs'))
  await editProjectFilm(root, null, [{ op: 'uncaptions', src: CAPTIONS.src }])
  write(root, agentWidensB(start('attrs')))
  await settleProjectFilm(root)
  assert.equal(clip(read(root), 'b').box.w, 1280)
  assert.equal(holders(read(root), 'captions')[0], null)
})

test("a caption track the agent adds or removes beside the person's edit is added or removed", async () => {
  const film = start('attrs')
  film.tracks.pop()
  const root = await project(film)
  await personMovesA(root)
  /* (b moved too: a copy with the track is then not as near the person's version from before it as to the merge) */
  const added = {
    ...structuredClone(film),
    tracks: [...structuredClone(film.tracks), { clips: [], captions: CAPTIONS }]
  }
  clip(added, 'b').at = 5
  write(root, added)
  await settleProjectFilm(root)
  assert.equal(clip(read(root), 'a').at, 2)
  assert.deepEqual(holders(read(root), 'captions')[0]?.captions, CAPTIONS)
  /* the agent reads the film as it is now, the person edits again, then the agent writes its copy without the track */
  const copy = read(root)
  await editProjectFilm(root, null, [{ op: 'set', clip: 'a', field: 'at', value: 3 }])
  write(root, { ...copy, tracks: copy.tracks.filter(t => t.clips.length) })
  await settleProjectFilm(root)
  assert.equal(clip(read(root), 'a').at, 3)
  assert.equal(holders(read(root), 'captions')[0], null)
})

test("a version kept beside the one before it has each caption track's own <track> and fields", async () => {
  const { keepFilm, keptValue } = await load('studio/server/person-merge.mjs')
  const en = { src: 'captions/en.vtt', kind: 'subtitles', srclang: 'en', label: 'English' }
  const film = {
    stage: { w: 1920, h: 1080 },
    tracks: [{ clips: [page('a')] }, { clips: [], captions: CAPTIONS }, { clips: [], hidden: true, captions: en }]
  }
  const before = keepFilm(film)
  assert.deepEqual(keptValue(before), film)
  const swapped = { ...film, tracks: [film.tracks[0], film.tracks[2], film.tracks[1]] }
  assert.deepEqual(keptValue(keepFilm(swapped, before)), swapped)
  const changed = structuredClone(film)
  changed.tracks[1].attrs = { class: 'karaoke' }
  assert.deepEqual(keptValue(keepFilm(changed, before)), changed)
})

for (const f of ['attrs', 'captions']) {
  test(`${f}: the person's edit of it alone is a version of its own`, async () => {
    const root = await project(start(f))
    const before = personEdits.keptVersions(root).hashes
    await changeProjectFilm(root, value => {
      for (const track of holders(value, f)) setField(track, f, SAMPLES[f][1])
      return { value }
    })
    const after = personEdits.keptVersions(root).hashes
    assert.equal(after.length, before.length + 1, 'kept as a new version, not as the one before it')
    assert.equal(after.at(-1), personEdits.versionHash(read(root)))
  })
}

/** Changes to a film with caption tracks and track fields: the kept versions' quick comparison counts as units do. */
const CHANGES = {
  'add a caption track': f =>
    f.tracks.push({ clips: [], captions: { src: 'captions/ja.vtt', kind: 'subtitles', srclang: 'ja' } }),
  'remove a caption track': f => f.tracks.splice(1, 1),
  'hide a caption track': f => {
    f.tracks[1].hidden = true
  },
  'unmute a caption track': f => {
    delete f.tracks[2].muted
  },
  "lock the clips' track": f => {
    f.tracks[0].locked = true
  },
  "give the clips' track attributes": f => {
    f.tracks[0].attrs = { class: 'b-roll' }
  },
  "change a caption track's attributes": f => {
    f.tracks[2].attrs = { 'data-style': 'outline' }
  },
  'rename a caption track': f => {
    f.tracks[1].captions.label = '简体中文'
  },
  'move a caption track first': f => f.tracks.unshift(f.tracks.splice(2, 1)[0]),
  'swap the caption tracks': f => {
    ;[f.tracks[1], f.tracks[2]] = [f.tracks[2], f.tracks[1]]
  },
  "remove the clips' track": f => f.tracks.splice(0, 1),
  'move a clip to a new track': f => f.tracks.push({ clips: [f.tracks[0].clips.pop()], attrs: { class: 'new' } })
}
for (const [name, change] of Object.entries(CHANGES)) {
  test(`kept versions compare as their units do: ${name}`, async () => {
    const { compare, distance, keepFilm, unitsOf } = await load('studio/server/person-merge.mjs')
    const a = {
      stage: { w: 1920, h: 1080 },
      tracks: [
        { clips: [page('a'), page('b', { at: 4 })], attrs: { class: 'a-roll' } },
        { clips: [], captions: structuredClone(CAPTIONS) },
        {
          clips: [],
          muted: true,
          attrs: { 'data-style': 'box' },
          captions: { src: 'captions/en.vtt', kind: 'subtitles', srclang: 'en' }
        }
      ]
    }
    const b = structuredClone(a)
    change(b)
    /* (a write lacking what a version has is no nearer or farther for it: seen one way at least) */
    let seen = 0
    for (const [x, y] of [
      [a, b],
      [b, a]
    ]) {
      const quick = compare(keepFilm(x), keepFilm(y)).distance
      assert.equal(quick, distance(unitsOf(x), unitsOf(y)))
      seen += quick
    }
    assert.ok(seen > 0, 'the change is seen')
  })
}

test('two caption tracks keep their order when the person moves the second above the first', async () => {
  const en = { src: 'captions/en.vtt', kind: 'subtitles', srclang: 'en', label: 'English' }
  const film = start('captions')
  film.tracks.push({ clips: [], captions: en })
  const root = await project(film)
  await editProjectFilm(root, null, [{ op: 'reorder', from: 2, to: 1 }])
  assert.deepEqual(
    read(root).tracks.map(t => t.captions?.src ?? 'clips'),
    ['clips', en.src, CAPTIONS.src]
  )
  write(root, agentWidensB(structuredClone(film)))
  await settleProjectFilm(root)
  assert.equal(clip(read(root), 'b').box.w, 1280)
  assert.deepEqual(
    read(root).tracks.map(t => t.captions?.src ?? 'clips'),
    ['clips', en.src, CAPTIONS.src]
  )
})
