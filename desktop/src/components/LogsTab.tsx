import { useEffect, useRef } from 'react'
import { Button, Card, CardHeader, CardContent } from '@heroui/react'
import type { LogMessage } from '../types.d'

interface Props {
  logs: LogMessage[]
  onClear: () => void
}

export default function LogsTab({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const colorClass = (level: string) => {
    if (level === 'error') return 'text-danger'
    if (level === 'warn') return 'text-warning'
    return 'text-foreground-400'
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Card className="bg-content1">
        <CardHeader className="flex justify-between items-center pb-0">
          <span className="text-xs font-semibold text-foreground-500 uppercase tracking-wider">Server Log</span>
          <Button size="sm" variant="ghost" onPress={onClear}>
            Clear
          </Button>
        </CardHeader>
        <CardContent>
          <div
            className="bg-[#08080f] rounded-lg border border-divider font-mono text-xs p-3 h-[400px] overflow-y-auto leading-relaxed"
          >
            {logs.length === 0 ? (
              <span className="text-foreground-500 italic">No logs yet…</span>
            ) : (
              logs.map((log, i) => {
                const ts = new Date().toTimeString().slice(0, 8)
                return (
                  <div key={i} className={`${colorClass(log.level)} py-px`}>
                    <span className="text-foreground-600 mr-2">[{ts}]</span>
                    {log.text}
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
