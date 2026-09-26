import * as http from 'http';
import * as https from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

/** Read-only reachability, not a claim that authentication/inference works. */
export async function assertDirectServiceReachable(
  baseUrl: string,
  bearerToken: string,
  resolveProxy?: (url: string) => Promise<string | undefined>
): Promise<void> {
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('API 地址必须使用 HTTP 或 HTTPS，请检查服务设置。');
  const proxyUrl = await resolveProxy?.(target.href);
  const agent = proxyUrl
    ? target.protocol === 'https:' ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl)
    : undefined;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.get(target, {
        agent, headers: { authorization: `Bearer ${bearerToken}`, 'user-agent': 'xwx-deck-route-preflight' }
      }, res => {
        resolve(res.statusCode ?? 502);
        res.destroy();
      });
      const timer = setTimeout(() => req.destroy(new Error('连接检查超时')), 12_000);
      req.once('error', reject);
      req.once('close', () => clearTimeout(timer));
    });
    if (status >= 500) throw new Error(`HTTP ${status}`);
  } catch (error) {
    const status = /HTTP 5\d\d/.exec((error as Error).message)?.[0];
    throw new Error(`目标服务连通性检查失败${status ? `（${status}）` : '（网络连接失败或超时）'}，已保留原客户端配置。请检查网络、系统代理及服务商状态后重试。`);
  } finally {
    agent?.destroy();
  }
}
