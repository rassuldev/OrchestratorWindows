import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, latestVerifierShots } from '../../web/src/api.js'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('api', () => {
  it('posts input as JSON and returns the new state', async () => {
    const fetch = stubFetch(200, { state: { id: 'p1' } })
    expect(await api.postInput('p1', { kind: 'approve' })).toEqual({ id: 'p1' })
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kind":"approve"}',
    })
  })

  it('turns a 409 into «Состояние уже изменилось» and other errors into an ApiError with the server message', async () => {
    stubFetch(409, { error: 'checkpoint mismatch' })
    await expect(api.postInput('p1', { kind: 'approve' })).rejects.toMatchObject({ status: 409, message: 'Состояние уже изменилось' })
    stubFetch(400, { error: 'invalid input' })
    const err = await api.postInput('p1', { kind: 'approve' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, message: 'invalid input' })
  })

  it('only /input maps 409 to «Состояние уже изменилось»; other 409s keep the server message', async () => {
    stubFetch(409, { error: 'project has no run command yet' })
    await expect(api.startApp('p1')).rejects.toMatchObject({ status: 409, message: 'project has no run command yet' })
  })

  it('getDoc returns null for a missing document', async () => {
    stubFetch(404, { error: 'doc not found' })
    expect(await api.getDoc('p1', 'spec')).toBeNull()
  })

  it('builds asset URLs with encoded segments', () => {
    expect(api.assetUrl('p 1', 'screenshots/t1 a1/home.png')).toBe('/api/projects/p%201/asset/screenshots/t1%20a1/home.png')
  })
})

describe('latestVerifierShots', () => {
  it('picks the newest verifier run folder, ignoring design and implementer shots', () => {
    expect(
      latestVerifierShots([
        'design/a-desktop.png',
        'screenshots/t3-impl/desktop.png',
        'screenshots/t2-a2/home/desktop.png',
        'screenshots/t1-a1/home/desktop.png',
        'screenshots/t2-a2/home/mobile.png',
      ]),
    ).toEqual(['screenshots/t2-a2/home/desktop.png', 'screenshots/t2-a2/home/mobile.png'])
    expect(latestVerifierShots(['design/a-desktop.png'])).toEqual([])
  })
})
