import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { resolveProxyForURL } from './proxy';

const proxyAgents = new Map<string, ProxyAgent>();

export function proxyAwareFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  const proxy = resolveProxyForURL(input instanceof Request ? input.url : input.toString());
  if (!proxy) {
    return fetch(input, init);
  }

  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...init,
    dispatcher: getProxyAgent(proxy)
  } as Parameters<typeof undiciFetch>[1]) as ReturnType<typeof fetch>;
}

function getProxyAgent(proxy: string): ProxyAgent {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}
