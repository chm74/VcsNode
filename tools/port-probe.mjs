#!/usr/bin/env node
/**
 * vcsNode 端口连通性探测
 *
 * 用法:
 *   node port-probe.mjs listen [port]                 # 在被测机器上起临时监听
 *   node port-probe.mjs probe  [port] host1 host2 ... # 在发起方探测
 *
 * 示例:
 *   ...98  上:  node port-probe.mjs listen 47821
 *   ...98  上:  node port-probe.mjs probe 47821 172.16.2.98 172.16.1.149 172.16.1.207 172.16.1.145
 */

import net from 'node:net'

const [, , cmd = 'probe', argPort = '47821', ...hosts] = process.argv
const port = Number(argPort)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`端口不合法: ${argPort}`)
  process.exit(1)
}

if (cmd === 'listen') {
  const server = net.createServer((sock) => {
    console.log(`[+] 收到连接  from ${sock.remoteAddress}:${sock.remotePort}`)
    sock.end('ok')
  })
  server.on('error', (e) => {
    console.error(`[x] 监听失败: ${e.code} ${e.message}`)
    if (e.code === 'EADDRINUSE') console.error('    该端口已被占用。用 netstat -ano | findstr :' + port + ' 查占用进程')
    if (e.code === 'EACCES') console.error('    权限不足，Windows 上请以管理员运行，或换一个 >1024 的端口')
    process.exit(1)
  })
  server.listen(port, '0.0.0.0', () => {
    console.log(`[*] 正在监听 0.0.0.0:${port}`)
    console.log('    保持这个窗口不要关，到另一台机器执行 probe')
  })
  process.on('SIGINT', () => { console.log('\n[*] 已停止监听'); process.exit(0) })
} else {
  const targets = hosts.length ? hosts : ['127.0.0.1']

  const probe = (host) =>
    new Promise((resolve) => {
      const t0 = Date.now()
      const sock = net.connect({ host, port })
      let settled = false
      const done = (r) => {
        if (settled) return
        settled = true
        sock.destroy()
        resolve({ host, ms: Date.now() - t0, ...r })
      }
      sock.setTimeout(3000)
      sock.on('connect', () => {
        const local = `${sock.localAddress}:${sock.localPort}`
        done({ ok: true, local })
      })
      sock.on('timeout', () => done({ ok: false, code: 'ETIMEDOUT' }))
      sock.on('error', (e) => done({ ok: false, code: e.code || e.message }))
    })

  const diagnosis = (r) => {
    if (r.ok) return '通'
    switch (r.code) {
      case 'ECONNREFUSED':
        return '网络通，但对端没有监听 -> 只是服务没起'
      case 'ETIMEDOUT':
        return '无响应 -> 防火墙/ACL 丢包，或路由不通'
      case 'EHOSTUNREACH':
        return '主机不可达 -> 路由问题'
      case 'ENETUNREACH':
        return '本机没有到该网段的路由'
      case 'EADDRNOTAVAIL':
        return '本机没有该网段的地址'
      default:
        return String(r.code)
    }
  }

  const results = await Promise.all(targets.map(probe))
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))

  console.log(`\n探测 ${port}/tcp    本机出口: ${results.find((r) => r.ok)?.local ?? '(未建立任何连接)'}\n`)
  console.log(pad('目标', 20) + pad('耗时', 8) + pad('结果', 8) + '诊断')
  console.log('-'.repeat(88))
  for (const r of results) {
    console.log(
      pad(r.host, 20) + pad(r.ms + 'ms', 8) + pad(r.ok ? 'OK' : 'FAIL', 8) + diagnosis(r),
    )
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n合计 ${results.length} 个目标，成功 ${results.length - failed.length}，失败 ${failed.length}`)
  process.exit(failed.length ? 1 : 0)
}
