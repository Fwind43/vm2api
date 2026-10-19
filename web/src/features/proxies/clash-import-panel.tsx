import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useRefreshProxies } from './queries'

type Source = {
  id: string
  name: string
  nodes: number
  has_url: boolean
  auto_refresh: boolean
  refresh_interval_minutes: number
  last_success_at: string | null
  next_refresh_at: string | null
  last_error: string | null
}
type Status = { configured: boolean; sources: Source[] }
type SourceAction = {
  action: 'refresh' | 'configure'
  source_id: string
  auto_refresh?: boolean
  refresh_interval_minutes?: number
}
const timeLabel = (time: string | null) =>
  time ? new Date(time).toLocaleString() : '—'

function SourceRow({
  source,
  pending,
  onAction,
}: {
  source: Source
  pending: boolean
  onAction: (action: SourceAction) => void
}) {
  const [interval, setInterval] = useState(
    String(source.refresh_interval_minutes)
  )
  const minutes = Number(interval)
  const configure = (enabled: boolean) =>
    onAction({
      action: 'configure',
      source_id: source.id,
      auto_refresh: enabled,
      refresh_interval_minutes: minutes,
    })
  return (
    <li className='space-y-2 rounded-md border p-3'>
      <div>
        {source.name} · {source.nodes} 个节点 ·{' '}
        {source.auto_refresh ? '自动更新已开启' : '自动更新已关闭'}
      </div>
      {source.has_url ? (
        <>
          <div>
            上次成功：{timeLabel(source.last_success_at)}；下次更新：
            {timeLabel(source.next_refresh_at)}
          </div>
          {source.last_error ? (
            <p role='alert' className='text-destructive'>
              {source.last_error === 'bound_nodes_changed'
                ? '在用节点配置变化，已保留旧配置；请确认后手动重导入。'
                : '更新失败，已保留旧配置；开启自动更新时将于15分钟后重试。'}
            </p>
          ) : null}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={pending}
              onClick={() =>
                onAction({ action: 'refresh', source_id: source.id })
              }
            >
              立即更新
            </Button>
            <Input
              type='number'
              min={15}
              max={10080}
              step={1}
              className='w-24'
              aria-label={`${source.name} 更新间隔（分钟）`}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            />
            <span>分钟</span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={
                pending ||
                !Number.isInteger(minutes) ||
                minutes < 15 ||
                minutes > 10080
              }
              onClick={() => configure(source.auto_refresh)}
            >
              保存间隔
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={
                pending ||
                !Number.isInteger(minutes) ||
                minutes < 15 ||
                minutes > 10080
              }
              onClick={() => configure(!source.auto_refresh)}
            >
              {source.auto_refresh ? '暂停自动更新' : '开启自动更新'}
            </Button>
          </div>
        </>
      ) : (
        <p>旧订阅或 YAML 导入未保存链接，请使用相同名称重新导入链接一次。</p>
      )}
    </li>
  )
}
type Result = {
  added: number
  updated: number
  retained_disabled: number
  skipped: { name: string; reason: string }[]
}

export function ClashImportPanel() {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [yaml, setYaml] = useState('')
  const [fileError, setFileError] = useState('')
  const refresh = useRefreshProxies()
  const status = useQuery({
    queryKey: ['panel', 'clash-subscriptions'],
    queryFn: () => api<Status>('/api/panel/proxies/clash'),
    refetchInterval: 60000,
  })
  const mutation = useMutation({
    mutationFn: () =>
      api<Result>('/api/panel/proxies/clash', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(url.trim() ? { url: url.trim() } : { yaml }),
        }),
      }),
    onSuccess: (result) => {
      toast.success(
        `新增 ${result.added}，更新 ${result.updated}，停用缺失节点 ${result.retained_disabled}`
      )
      setUrl('')
      setYaml('')
      void refresh()
      void status.refetch()
    },
  })

  const sourceMutation = useMutation({
    mutationFn: (action: SourceAction) =>
      api('/api/panel/proxies/clash', {
        method: 'POST',
        body: JSON.stringify(action),
      }),
    onSuccess: (_, action) => {
      toast.success(
        action.action === 'refresh' ? '订阅已更新' : '自动更新设置已保存'
      )
      void refresh()
      void status.refetch()
    },
    onError: () => {
      void status.refetch()
    },
  })

  return (
    <section className='space-y-3 border-t pt-4' aria-label='Clash 订阅'>
      <div>
        <h3 className='text-sm font-semibold'>Clash 订阅</h3>
        <p className='mt-1 text-xs text-muted-foreground'>
          节点经 Mihomo 转为独立 SOCKS5
          出口。相同订阅名称再次导入即更新，已有绑定不会切换到其他节点。
        </p>
      </div>
      {status.isPending ? <p className='text-xs'>检查 Mihomo 配置…</p> : null}
      {status.error ? (
        <p role='alert' className='text-xs text-destructive'>
          {status.error.message}
        </p>
      ) : null}
      {status.data && !status.data.configured ? (
        <p role='alert' className='text-xs text-muted-foreground'>
          尚未配置 Mihomo。请按 docs/CLASH.md 启动专用内核并设置
          VM2API_CLASH_CONTROLLER / VM2API_CLASH_SECRET。
        </p>
      ) : null}
      <Input
        aria-label='订阅名称'
        placeholder='订阅名称（相同名称用于更新）'
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={64}
      />
      <Input
        aria-label='Clash 订阅链接'
        type='password'
        autoComplete='off'
        placeholder='Clash YAML 订阅链接（服务端下载）'
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <p className='text-xs text-muted-foreground'>
        链接将在服务端保存（不回显），新订阅默认每6小时更新，重启后继续。
        内容不变不重载；更新失败保留旧配置，在用节点变更需手动确认。
      </p>
      <div className='text-xs text-muted-foreground'>
        或上传 / 粘贴 YAML（最多 2 MiB，500 个节点）
      </div>
      <Input
        aria-label='上传 Clash YAML'
        type='file'
        accept='.yaml,.yml,.txt'
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          if (file.size > 2 * 1024 * 1024) {
            setFileError('文件不能超过 2 MiB')
            return
          }
          try {
            setYaml(await file.text())
            setUrl('')
            setFileError('')
          } catch {
            setFileError('无法读取文件')
          }
        }}
      />
      <Textarea
        aria-label='Clash YAML 内容'
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        placeholder={
          'proxies:\n  - name: node-1\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: ...'
        }
        className='min-h-32 font-mono text-xs'
      />
      <p className='text-xs text-muted-foreground'>
        只读取 proxies 节点，不导入规则、DNS 或脚本。不支持仅含 proxy-providers
        的配置或 Base64 通用订阅；请使用机场的 Clash/Mihomo 格式。
      </p>
      {fileError || mutation.error ? (
        <p role='alert' className='text-xs text-destructive'>
          {fileError || mutation.error?.message}
        </p>
      ) : null}
      {mutation.data?.skipped.length ? (
        <p className='text-xs text-muted-foreground'>
          跳过 {mutation.data.skipped.length} 个不支持的节点：
          {mutation.data.skipped.map((n) => n.name).join('、')}
        </p>
      ) : null}
      <Button
        type='button'
        onClick={() => mutation.mutate()}
        disabled={
          !status.data?.configured ||
          mutation.isPending ||
          sourceMutation.isPending ||
          !name.trim() ||
          (!url.trim() && !yaml.trim())
        }
      >
        {mutation.isPending ? '正在导入…' : '导入 / 更新 Clash 订阅'}
      </Button>
      {sourceMutation.error ? (
        <p role='alert' className='text-xs text-destructive'>
          {sourceMutation.error.message}
        </p>
      ) : null}
      {status.data?.sources.length ? (
        <ul className='space-y-1 text-xs text-muted-foreground'>
          {status.data.sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              pending={
                mutation.isPending ||
                sourceMutation.isPending ||
                !status.data.configured
              }
              onAction={(action) => sourceMutation.mutate(action)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
