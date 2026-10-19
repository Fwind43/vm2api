import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClashImportPanel } from './clash-import-panel'

function render(overrides: Record<string, unknown> = {}, configured = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['panel', 'clash-subscriptions'], {
    configured,
    sources: [
      {
        id: 'source-1',
        name: 'airport',
        nodes: 2,
        has_url: true,
        auto_refresh: true,
        refresh_interval_minutes: 360,
        last_success_at: null,
        next_refresh_at: null,
        last_error: null,
        ...overrides,
      },
    ],
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ClashImportPanel />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

describe('saved Clash subscription controls', () => {
  it('renders refresh, pause and interval controls without a saved URL field', () => {
    const html = render()
    expect(html).toContain('\u7acb\u5373\u66f4\u65b0')
    expect(html).toContain('\u6682\u505c\u81ea\u52a8\u66f4\u65b0')
    expect(html).toContain('value="360"')
    expect(html).toContain('min="15"')
    expect(html).toContain('max="10080"')
    expect(html).not.toContain('value="https://')
  })

  it('shows resume and the bound-node protection message', () => {
    const html = render({
      auto_refresh: false,
      last_error: 'bound_nodes_changed',
    })
    expect(html).toContain('\u5f00\u542f\u81ea\u52a8\u66f4\u65b0')
    expect(html).toContain('\u5df2\u4fdd\u7559\u65e7\u914d\u7f6e')
    expect(html).toContain('\u624b\u52a8\u91cd\u5bfc\u5165')
  })

  it('asks legacy/YAML sources to save a URL by reimporting once', () => {
    const html = render({ has_url: false, auto_refresh: false })
    expect(html).toContain('\u91cd\u65b0\u5bfc\u5165\u94fe\u63a5\u4e00\u6b21')
    expect(html).not.toContain('\u7acb\u5373\u66f4\u65b0')
  })

  it('disables immediate refresh when the sidecar is not configured', () => {
    const html = render({}, false)
    const refreshButton = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((button) => button.includes('\u7acb\u5373\u66f4\u65b0'))
    expect(refreshButton).toMatch(/\sdisabled=""/)
  })
})
