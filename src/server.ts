import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import Bonjour from "bonjour-service";
import { WebSocket, WebSocketServer } from "ws";
import {
  messageId,
  terminalMessageSchema,
  type PaymentCreateMessage,
  type PaymentMethod,
  type TerminalMessage
} from "./protocol.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const terminalPath = process.env.TERMINAL_PATH ?? "/v1/terminal";
const gatewayId = process.env.GATEWAY_ID ?? "GW-SIMULATOR-01";
const mdnsName = process.env.MDNS_NAME ?? `Platech SmartPOS ${gatewayId}`;
const currentDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(currentDir, "..", "public");
const networkCheckIntervalMs = 2_000;
const mdnsRecoveryDelayMs = 2_000;
const mdnsWatchdogIntervalMs = Number(process.env.MDNS_WATCHDOG_INTERVAL_MS ?? 60_000);
const mdnsServiceType = "_platech-service._tcp.local.";

let terminal: WebSocket | undefined;
const dashboardClients = new Set<WebSocket>();
let bonjour: Bonjour | undefined;
let mdnsService: ReturnType<Bonjour["publish"]> | undefined;
let mdnsActive = false;
let announcedIpv4Addresses: string[] = [];
let mdnsLastPublishedAt: string | undefined;
let mdnsLastError: string | undefined;
let observedIpv4Signature: string | undefined;
let mdnsGeneration = 0;
let mdnsOperation = Promise.resolve();
let networkMonitor: NodeJS.Timeout | undefined;
let mdnsWatchdog: NodeJS.Timeout | undefined;
let mdnsRecoveryTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

function activeIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap(addresses => addresses ?? [])
    .filter(address => address.family === "IPv4" && !address.internal)
    .map(address => address.address)
    .sort();
}

function stopMdns(): Promise<void> {
  const currentBonjour = bonjour;
  const currentService = mdnsService;
  bonjour = undefined;
  mdnsService = undefined;
  mdnsActive = false;
  mdnsGeneration += 1;

  if (!currentBonjour) return Promise.resolve();

  return new Promise(resolve => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      try {
        currentBonjour.destroy();
      } catch {
        // A instância pode já ter sido encerrada após uma falha da interface.
      }
      resolve();
    };

    const fallback = setTimeout(finish, 750);
    fallback.unref();
    try {
      if (currentService) currentService.stop(finish);
      else finish();
    } catch {
      finish();
    }
  });
}

function scheduleMdnsRecovery(generation: number): void {
  if (shuttingDown || generation !== mdnsGeneration || mdnsRecoveryTimer) return;
  mdnsRecoveryTimer = setTimeout(() => {
    mdnsRecoveryTimer = undefined;
    if (shuttingDown || generation !== mdnsGeneration) return;
    queueMdnsRestart(activeIpv4Addresses(), "recuperação após erro");
  }, mdnsRecoveryDelayMs);
  mdnsRecoveryTimer.unref();
}

async function restartMdns(addresses: string[], reason: string): Promise<void> {
  await stopMdns();
  if (shuttingDown) return;

  if (addresses.length === 0) {
    announcedIpv4Addresses = [];
    console.warn(`mDNS suspenso (${reason}): nenhuma interface IPv4 local disponível.`);
    return;
  }

  const generation = mdnsGeneration;
  const instance = new Bonjour(undefined, (error: unknown) => {
    mdnsActive = false;
    mdnsLastError = String(error);
    console.error("Falha no serviço mDNS:", error);
    scheduleMdnsRecovery(generation);
  });
  bonjour = instance;
  const service = instance.publish({
    name: mdnsName,
    type: "platech-service",
    protocol: "tcp",
    port,
    disableIPv6: true,
    txt: {
      gatewayId,
      path: terminalPath,
      protocolVersion: "1",
      secure: "false"
    }
  });
  mdnsService = service;

  service.on("up", () => {
    if (generation !== mdnsGeneration) return;
    mdnsActive = true;
    announcedIpv4Addresses = [...addresses];
    mdnsLastPublishedAt = new Date().toISOString();
    mdnsLastError = undefined;
    console.log(`mDNS: ${mdnsName}._platech-service._tcp.local`);
    console.log(`Gateway ID: ${gatewayId}`);
    console.log(`IPv4 anunciado: ${addresses.join(", ")}`);
  });
  service.on("error", error => {
    if (generation !== mdnsGeneration) return;
    mdnsActive = false;
    mdnsLastError = String(error);
    console.error("Falha ao publicar serviço mDNS:", error);
    scheduleMdnsRecovery(generation);
  });
}

function queueMdnsRestart(addresses: string[], reason: string): void {
  mdnsOperation = mdnsOperation
    .then(() => restartMdns(addresses, reason))
    .catch(error => {
      console.error("Falha ao reiniciar serviço mDNS:", error);
    });
}

function checkNetworkInterfaces(): void {
  const addresses = activeIpv4Addresses();
  const signature = addresses.join(",");
  if (signature === observedIpv4Signature) return;

  const previous = observedIpv4Signature;
  observedIpv4Signature = signature;
  const reason = previous === undefined
    ? "inicialização"
    : `mudança de IPv4: ${previous || "sem rede"} -> ${signature || "sem rede"}`;
  console.log(`Rede local detectada: ${signature || "sem IPv4 disponível"}`);
  queueMdnsRestart(addresses, reason);
}

function checkMdnsHealth(): void {
  if (shuttingDown) return;

  const addresses = activeIpv4Addresses();
  if (addresses.length === 0) {
    if (bonjour || mdnsService || mdnsActive) {
      queueMdnsRestart([], "watchdog: rede local indisponível");
    }
    return;
  }

  const reason = mdnsActive
    ? "watchdog: republicação preventiva"
    : "watchdog: anúncio inativo";
  queueMdnsRestart(addresses, reason);
}

function send(socket: WebSocket | undefined, data: object): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));
  return true;
}

function broadcast(data: object): void {
  const envelope = JSON.stringify(data);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) client.send(envelope);
  }
}

function terminalState(): void {
  broadcast({
    type: "simulator.terminal_state",
    connected: terminal?.readyState === WebSocket.OPEN
  });
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;

  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      terminalConnected: terminal?.readyState === WebSocket.OPEN,
      mdns: {
        active: mdnsActive,
        serviceType: mdnsServiceType,
        gatewayId,
        announcedAddresses: announcedIpv4Addresses,
        lastPublishedAt: mdnsLastPublishedAt ?? null,
        lastError: mdnsLastError ?? null
      }
    }));
    return;
  }

  const asset = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._-]+$/.test(asset)) {
    response.writeHead(404).end();
    return;
  }

  try {
    const content = await readFile(join(publicDir, asset));
    const contentType = asset.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

const terminalWss = new WebSocketServer({ noServer: true });
const dashboardWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  const selected = pathname === terminalPath ? terminalWss : pathname === "/v1/dashboard" ? dashboardWss : undefined;
  if (!selected) {
    socket.destroy();
    return;
  }
  selected.handleUpgrade(request, socket, head, ws => selected.emit("connection", ws, request));
});

terminalWss.on("connection", socket => {
  if (terminal?.readyState === WebSocket.OPEN) terminal.close(4001, "Another terminal connected");
  terminal = socket;
  terminalState();
  broadcast({ type: "log", direction: "system", payload: { message: "SmartPOS conectado" } });

  socket.on("message", raw => {
    try {
      const parsed = terminalMessageSchema.parse(JSON.parse(raw.toString()));
      broadcast({ type: "log", direction: "terminal_to_gateway", payload: parsed });
    } catch (error) {
      broadcast({ type: "log", direction: "system", payload: { message: "JSON inválido recebido", error: String(error) } });
    }
  });

  socket.on("close", () => {
    if (terminal === socket) terminal = undefined;
    terminalState();
    broadcast({ type: "log", direction: "system", payload: { message: "SmartPOS desconectado" } });
  });
});

dashboardWss.on("connection", socket => {
  dashboardClients.add(socket);
  terminalState();

  socket.on("message", raw => {
    let command: TerminalMessage;
    try {
      command = terminalMessageSchema.parse(JSON.parse(raw.toString()));
    } catch (error) {
      send(socket, { type: "simulator.error", message: "Comando inválido", detail: String(error) });
      return;
    }

    if (command.type === "simulator.payment_create") {
      const amount = command.amount;
      const paymentMethod = command.paymentMethod || undefined;
      if (!amount || (paymentMethod && !["debit", "credit", "pix"].includes(paymentMethod))) {
        send(socket, { type: "simulator.error", message: "Valor ou método inválido" });
        return;
      }
      const installments = paymentMethod === "credit" ? command.installments ?? 1 : undefined;
      if (
        paymentMethod === "credit" &&
        (!Number.isInteger(installments) || installments! < 1 || installments! > 12)
      ) {
        send(socket, { type: "simulator.error", message: "Informe de 1 a 12 parcelas" });
        return;
      }
      if (
        paymentMethod === "credit" &&
        installments! > 1 &&
        amount < installments! * 500
      ) {
        send(socket, {
          type: "simulator.error",
          message: "O valor de cada parcela deve ser de no mínimo R$ 5,00"
        });
        return;
      }
      const payment: PaymentCreateMessage = {
        type: "payment.create",
        messageId: messageId(),
        sessionId: command.sessionId ?? `test-${Date.now()}`,
        amount,
        ...(paymentMethod ? { paymentMethod: paymentMethod as PaymentMethod } : {}),
        ...(paymentMethod === "credit" ? { installments } : {}),
        description: "Pagamento de teste"
      };
      if (!send(terminal, payment)) send(socket, { type: "simulator.error", message: "SmartPOS não conectado" });
      else broadcast({ type: "log", direction: "gateway_to_terminal", payload: payment });
      return;
    }

    const outgoing = {
      ...command,
      type: command.type.replace(/^simulator\./, ""),
      messageId: command.messageId ?? messageId()
    };
    if (!send(terminal, outgoing)) send(socket, { type: "simulator.error", message: "SmartPOS não conectado" });
    else broadcast({ type: "log", direction: "gateway_to_terminal", payload: outgoing });
  });

  socket.on("close", () => dashboardClients.delete(socket));
});

server.listen(port, host, () => {
  checkNetworkInterfaces();
  networkMonitor = setInterval(checkNetworkInterfaces, networkCheckIntervalMs);
  networkMonitor.unref();
  mdnsWatchdog = setInterval(checkMdnsHealth, mdnsWatchdogIntervalMs);
  mdnsWatchdog.unref();

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (networkMonitor) clearInterval(networkMonitor);
    if (mdnsWatchdog) clearInterval(mdnsWatchdog);
    if (mdnsRecoveryTimer) clearTimeout(mdnsRecoveryTimer);
    mdnsOperation
      .then(stopMdns)
      .finally(() => server.close(() => process.exit(0)));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`Painel: http://localhost:${port}`);
  console.log(`SmartPOS manual: ws://IP_DO_SERVIDOR:${port}${terminalPath}`);
});
