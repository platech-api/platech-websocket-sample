# Simulador WebSocket SmartPOS

Servidor WebSocket com painel para testar a integração com o SmartPOS.

Requer Node.js 20 ou superior.

## Executar

```bash
npm install
npm run start
```

Abra o painel:

```text
http://localhost:8080
```

## Conectar o SmartPOS

O SmartPOS e o servidor devem estar na mesma rede local.

Na descoberta automática, selecione o gateway exibido na tela **Comunicação**.

Para configurar manualmente, use o IPv4 da máquina que executa o simulador:

```text
ws://IP_DO_SERVIDOR:8080/v1/terminal
```

## Painel

- Escolha do meio de pagamento no SmartPOS quando o método não for informado.
- Débito, crédito de 1 a 12 parcelas e Pix.
- Impressão opcional da via do cliente no pagamento; por padrão, permanece habilitada.
- Cancelamento de uma operação em andamento.
- Consulta das transações disponíveis no SmartPOS.
- Solicitação de cancelamento por `transactionId`; o SmartPOS valida seu histórico e chama o backend.
- Impressão obrigatória da via do estabelecimento e via do cliente opcional no cancelamento.
- Visualização das mensagens JSON.

## Endpoints

- Painel: `GET /`
- Estado do simulador: `GET /health`
- SmartPOS: `WS /v1/terminal`
- Painel: `WS /v1/dashboard`

**Simulador destinado exclusivamente a testes.**
