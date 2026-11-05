import {
  Env,
  MetaInfo,
  StandardCheckoutClient,
  StandardCheckoutPayRequest,
  type CallbackResponse,
} from "@phonepe-pg/pg-sdk-node";
import { randomBytes } from "node:crypto";
import { config, isPhonePeConfigured } from "../config.js";
import { fulfillSubscription } from "../lib/fulfillSubscription.js";
import {
  planAmountPaise,
  planSlugToEnum,
  type PlanSlug,
} from "../lib/planPricing.js";
import { prisma } from "../lib/prisma.js";
import { toUserPublic, userInclude } from "../lib/userDto.js";
import {
  buildCheckoutPayBody,
  createPhonePeCheckoutOrder,
} from "./phonepeCheckout.js";

let client: StandardCheckoutClient | null = null;

function phonePeEnv(): Env {
  return config.PHONEPE_ENVIRONMENT === "PRODUCTION"
    ? Env.PRODUCTION
    : Env.SANDBOX;
}

export function getPhonePeClient(): StandardCheckoutClient {
  if (!isPhonePeConfigured()) {
    throw new Error("PhonePe is not configured on the server");
  }
  if (!client) {
    client = StandardCheckoutClient.getInstance(
      config.PHONEPE_CLIENT_ID!,
      config.PHONEPE_CLIENT_SECRET!,
      config.PHONEPE_CLIENT_VERSION,
      phonePeEnv(),
      false,
    );
  }
  return client;
}

export function generateMerchantOrderId(): string {
  const suffix = randomBytes(4).toString("hex");
  return `SMT_${Date.now()}_${suffix}`;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local"))
    return true;
  if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Redirect after payment. In sandbox, empty string = Zelton-style (open PhonePe + poll; no redirect page).
 * Do not fall back to PUBLIC_API_URL — LAN http/https IPs are not reachable by PhonePe.
 */
export function buildPaymentRedirectUrl(): string {
  const configured = config.PHONEPE_REDIRECT_BASE_URL?.trim() ?? "";

  if (!configured) {
    if (config.PHONEPE_ENVIRONMENT === "SANDBOX") {
      return "";
    }
    throw new Error(
      "Set PHONEPE_REDIRECT_BASE_URL to your public HTTPS API URL for production.",
    );
  }

  return `${configured.replace(/\/$/, "")}/payment-complete`;
}

export function getRedirectSetupError(redirectUrl: string): string | null {
  if (redirectUrl === "") {
    return null;
  }

  let host = "";
  try {
    host = new URL(redirectUrl).hostname;
  } catch {
    return "PHONEPE_REDIRECT_BASE_URL is not a valid URL.";
  }

  if (isPrivateOrLocalHost(host)) {
    return [
      "PHONEPE_REDIRECT_BASE_URL cannot be a LAN IP (PhonePe cannot reach it).",
      "Sandbox: leave PHONEPE_REDIRECT_BASE_URL empty and use Card/Net Banking on the PhonePe page (app polls).",
      "Or run npm run phonepe:tunnel and paste the https URL here.",
    ].join(" ");
  }

  if (!redirectUrl.startsWith("https://")) {
    return "PHONEPE_REDIRECT_BASE_URL must be https:// (public URL).";
  }

  return null;
}

export async function initiateSubscriptionPayment(
  userId: string,
  plan: PlanSlug,
) {
  const redirectUrl = buildPaymentRedirectUrl();
  const redirectError = getRedirectSetupError(redirectUrl);
  if (redirectError) {
    throw new Error(redirectError);
  }

  const amountPaise = planAmountPaise(plan);
  const merchantOrderId = generateMerchantOrderId();
  const planEnum = planSlugToEnum(plan);
  const isSandbox = config.PHONEPE_ENVIRONMENT === "SANDBOX";

  await prisma.payment.create({
    data: {
      userId,
      plan: planEnum,
      amountPaise,
      merchantOrderId,
      status: "PENDING",
    },
  });

  const response = isSandbox
    ? await createPhonePeCheckoutOrder(
        buildCheckoutPayBody({
          merchantOrderId,
          amountPaise,
          redirectUrl,
          userId,
          plan,
          sandboxCardOnly: true,
        }),
      )
    : await getPhonePeClient().pay(
        StandardCheckoutPayRequest.builder()
          .merchantOrderId(merchantOrderId)
          .amount(amountPaise)
          .redirectUrl(redirectUrl)
          .message("Smittenz subscription")
          .expireAfter(1200)
          .metaInfo(new MetaInfo(userId, plan))
          .build(),
      );

  await prisma.payment.update({
    where: { merchantOrderId },
    data: { phonepeOrderId: response.orderId },
  });

  return {
    success: true as const,
    merchant_order_id: merchantOrderId,
    order_id: response.orderId,
    redirect_url: response.redirectUrl,
    state: response.state,
  };
}

export type PaymentVerifyState = "PENDING" | "COMPLETED" | "FAILED";

export async function verifyAndSyncPayment(
  merchantOrderId: string,
  userId?: string,
) {
  const payment = await prisma.payment.findUnique({
    where: { merchantOrderId },
    include: { user: { include: userInclude } },
  });

  if (!payment) {
    return { success: false as const, error: "Payment not found" };
  }

  if (userId && payment.userId !== userId) {
    return { success: false as const, error: "Forbidden" };
  }

  if (payment.status === "COMPLETED") {
    const user = await toUserPublic(payment.user);
    const inviteCode = payment.user.couple?.inviteCode ?? null;
    return {
      success: true as const,
      state: "COMPLETED" as PaymentVerifyState,
      merchant_order_id: merchantOrderId,
      invite_code: inviteCode,
      user,
    };
  }

  if (payment.status === "FAILED") {
    return {
      success: true as const,
      state: "FAILED" as PaymentVerifyState,
      merchant_order_id: merchantOrderId,
    };
  }

  const orderStatus = await getPhonePeClient().getOrderStatus(merchantOrderId);
  const state = orderStatus.state as PaymentVerifyState;

  if (state === "COMPLETED") {
    const result = await handlePaymentCompleted(
      merchantOrderId,
      orderStatus.orderId,
      orderStatus,
    );
    return {
      success: true as const,
      state: "COMPLETED" as const,
      merchant_order_id: merchantOrderId,
      invite_code: result.inviteCode,
      user: result.user,
    };
  }

  if (state === "FAILED") {
    await handlePaymentFailed(merchantOrderId);
    return {
      success: true as const,
      state: "FAILED" as const,
      merchant_order_id: merchantOrderId,
    };
  }

  await prisma.payment.update({
    where: { merchantOrderId },
    data: {
      phonepeOrderId: orderStatus.orderId,
      phonepeTransactionId:
        orderStatus.paymentDetails?.[0]?.transactionId ?? undefined,
    },
  });

  return {
    success: true as const,
    state: "PENDING" as const,
    merchant_order_id: merchantOrderId,
  };
}

async function handlePaymentCompleted(
  merchantOrderId: string,
  phonepeOrderId: string,
  orderStatus?: { paymentDetails?: { transactionId?: string | number }[] },
) {
  const payment = await prisma.payment.findUnique({
    where: { merchantOrderId },
  });
  if (!payment) throw new Error("Payment not found");

  if (payment.status === "COMPLETED") {
    const existing = await prisma.user.findUnique({
      where: { id: payment.userId },
      include: userInclude,
    });
    if (!existing) throw new Error("User not found");
    return {
      inviteCode: existing.couple?.inviteCode ?? "",
      user: await toUserPublic(existing),
    };
  }

  const txId = orderStatus?.paymentDetails?.[0]?.transactionId;
  const txIdStr = txId != null ? String(txId) : undefined;

  const updated = await prisma.payment.updateMany({
    where: { merchantOrderId, status: "PENDING" },
    data: {
      status: "COMPLETED",
      phonepeOrderId,
      phonepeTransactionId: txIdStr,
    },
  });

  if (updated.count === 0) {
    const existing = await prisma.user.findUnique({
      where: { id: payment.userId },
      include: userInclude,
    });
    if (!existing) throw new Error("User not found");
    return {
      inviteCode: existing.couple?.inviteCode ?? "",
      user: await toUserPublic(existing),
    };
  }

  return fulfillSubscription(payment.userId, payment.plan);
}

async function handlePaymentFailed(merchantOrderId: string) {
  await prisma.payment.updateMany({
    where: { merchantOrderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}

export async function processPhonePeWebhook(
  authorization: string,
  rawBody: string,
): Promise<{ ok: boolean; error?: string }> {
  let callback: CallbackResponse;
  try {
    callback = getPhonePeClient().validateCallback(
      config.PHONEPE_WEBHOOK_USERNAME!,
      config.PHONEPE_WEBHOOK_PASSWORD!,
      authorization,
      rawBody,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid callback";
    return { ok: false, error: msg };
  }

  const merchantOrderId =
    callback.payload.originalMerchantOrderId ??
    callback.payload.merchantOrderId;
  if (!merchantOrderId) {
    return { ok: false, error: "Missing merchant order id" };
  }

  const state = callback.payload.state?.toUpperCase();

  if (state === "COMPLETED" || state === "SUCCESS") {
    await handlePaymentCompleted(merchantOrderId, callback.payload.orderId, {
      paymentDetails: callback.payload.paymentDetails,
    });
    return { ok: true };
  }

  if (state === "FAILED") {
    await handlePaymentFailed(merchantOrderId);
    return { ok: true };
  }

  return { ok: true };
}

/** Pre-warm OAuth token so the first pay() is faster. */
export async function warmupPhonePeClient(): Promise<void> {
  if (!isPhonePeConfigured()) return;
  getPhonePeClient();
}
