import { z } from "zod";

export const terminalMessageSchema = z.object({
  type: z.string().min(1),
  messageId: z.string().optional(),
  replyTo: z.string().optional(),
  sessionId: z.string().optional(),
  terminalId: z.string().optional(),
  status: z.string().optional(),
  transactionId: z.string().optional(),
  amount: z.number().int().positive().optional(),
  paymentMethod: z.enum(["debit", "credit", "pix"]).optional(),
  installments: z.number().int().optional(),
  printCustomerReceipt: z.boolean().optional(),
  reason: z.string().optional()
}).passthrough();

export type TerminalMessage = z.infer<typeof terminalMessageSchema>;

export type PaymentMethod = "debit" | "credit" | "pix";

export interface PaymentCreateMessage {
  type: "payment.create";
  messageId: string;
  sessionId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  installments?: number;
  description?: string;
}

export interface TransactionsListMessage {
  type: "transactions.list";
  messageId: string;
}

export interface TransactionCancelMessage {
  type: "transaction.cancel";
  messageId: string;
  transactionId: string;
  printCustomerReceipt?: boolean;
}

export function messageId(): string {
  return crypto.randomUUID();
}
