import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useRefreshProxies } from './queries'

type Status = {
  configured: boolean
  sources: { id: string; name: string; nodes: number }[]
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
          尚未配置 Mihomo。请按 docs/clash-subscriptions.md 启动专用内核并设置
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
          !name.trim() ||
          (!url.trim() && !yaml.trim())
        }
      >
        {mutation.isPending ? '正在导入…' : '导入 / 更新 Clash 订阅'}
      </Button>
      {status.data?.sources.length ? (
        <ul className='space-y-1 text-xs text-muted-foreground'>
          {status.data.sources.map((s) => (
            <li key={s.id}>
              {s.name} · {s.nodes} 个节点
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
