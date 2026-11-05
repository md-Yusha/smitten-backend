import { Router } from "express";
import { z } from "zod";
import { config, isPhonePeConfigured } from "../config.js";
import {
  assertOwnerCanPurchase,
  fulfillSubscription,
} from "../lib/fulfillSubscription.js";
import { planAmountPaise, planSlugToEnum } from "../lib/planPricing.js";
import { prisma } from "../lib/prisma.js";
import { userInclude } from "../lib/userDto.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import {
  buildPaymentRedirectUrl,
  getRedirectSetupError,
  initiateSubscriptionPayment,
  verifyAndSyncPayment,
  warmupPhonePeClient,
} from "../services/phonepeService.js";
import { confirmSubscriptionStatusForUser } from "../services/subscriptions.js";

const router = Router();

const planSchema = z.object({
  plan: z.enum(["monthly", "quarterly", "yearly"]),
});

function phonePeErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    ("httpStatusCode" in error || "type" in error)
  ) {
    const e = error as { httpStatusCode?: number; type?: string };
    if (e.httpStatusCode === 401 || e.type === "UnauthorizedAccess") {
      return [
        "PhonePe rejected the server credentials.",
        "Check PHONEPE_ENVIRONMENT, PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, and PHONEPE_CLIENT_VERSION.",
      ].join(" ");
    }
  }

  return error instanceof Error ? error.message : "Could not start payment";
}

/** Public — lets the app know whether to open PhonePe or use mock checkout. */
router.get("/config", (_req, res) => {
  let redirectUrl = "";
  let redirectError: string | null = null;
  if (isPhonePeConfigured()) {
    try {
      redirectUrl = buildPaymentRedirectUrl();
      redirectError = getRedirectSetupError(redirectUrl);
    } catch (e) {
      redirectError =
        e instanceof Error ? e.message : "Invalid redirect configuration";
    }
  }
  res.json({
    phonepeConfigured: isPhonePeConfigured(),
    redirectUrl: redirectUrl || null,
    redirectIsHttps: redirectUrl.startsWith("https://"),
    pollOnlyMode: redirectUrl === "",
    redirectError,
    sandboxEnvironment: config.PHONEPE_ENVIRONMENT === "SANDBOX",
    sandboxUsesCardFlow: config.PHONEPE_ENVIRONMENT === "SANDBOX",
  });
});

/** Create a PhonePe checkout session (receive-only). */
router.post("/initiate", requireAuth, async (req: AuthedRequest, res) => {
  if (!isPhonePeConfigured()) {
    res.status(503).json({
      error:
        "PhonePe is not configured. Set PHONEPE_* environment variables on the server.",
    });
    return;
  }

  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid plan" });
    return;
  }

  const userId = req.userId!;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userInclude,
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    assertOwnerCanPurchase(user);
  } catch (e) {
    res
      .status(400)
      .json({ error: e instanceof Error ? e.message : "Cannot purchase" });
    return;
  }

  const { plan } = parsed.data;

  try {
    const result = await initiateSubscriptionPayment(userId, plan);
    res.json(result);
  } catch (e) {
    console.error("[payments/initiate]", e);
    res.status(502).json({
      error: phonePeErrorMessage(e),
    });
  }
});

/** Poll payment status after the user returns from PhonePe. */
router.get(
  "/verify/:merchantOrderId",
  requireAuth,
  async (req: AuthedRequest, res) => {
    if (!isPhonePeConfigured()) {
      res.status(503).json({ error: "PhonePe is not configured" });
      return;
    }

    const merchantOrderId = String(req.params.merchantOrderId ?? "");
    if (!merchantOrderId || merchantOrderId === "undefined") {
      res.status(400).json({ error: "Missing merchant order id" });
      return;
    }

    try {
      const result = await verifyAndSyncPayment(merchantOrderId, req.userId!);
      if (!result.success) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (e) {
      console.error("[payments/verify]", e);
      res.status(502).json({
        error: e instanceof Error ? e.message : "Could not verify payment",
      });
    }
  },
);

/** Optional: pre-warm PhonePe OAuth token. */
router.get("/warmup", async (_req, res) => {
  try {
    await warmupPhonePeClient();
    res.json({ ok: true });
  } catch (e) {
    res
      .status(503)
      .json({ error: e instanceof Error ? e.message : "Warmup failed" });
  }
});

/** Mock payment for local dev without PhonePe credentials. */
router.post("/mock-checkout", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid plan" });
    return;
  }

  const userId = req.userId!;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userInclude,
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    assertOwnerCanPurchase(user);
  } catch (e) {
    res
      .status(400)
      .json({ error: e instanceof Error ? e.message : "Cannot purchase" });
    return;
  }

  const { plan } = parsed.data;
  const planEnum = planSlugToEnum(plan);
  const merchantOrderId = `MOCK_${Date.now()}`;

  await prisma.payment.create({
    data: {
      userId,
      plan: planEnum,
      amountPaise: planAmountPaise(plan),
      merchantOrderId,
      status: "PENDING",
    },
  });

  try {
    const result = await fulfillSubscription(userId, planEnum);

    await prisma.payment.update({
      where: { merchantOrderId },
      data: { status: "COMPLETED" },
    });

    res.json({
      ok: true,
      message: "Mock payment successful",
      inviteCode: result.inviteCode,
      user: result.user,
    });
  } catch (e) {
    await prisma.payment.update({
      where: { merchantOrderId },
      data: { status: "FAILED" },
    });
    throw e;
  }
});

router.get("/status", requireAuth, async (req: AuthedRequest, res) => {
  await confirmSubscriptionStatusForUser(req.userId!);
  const sub = await prisma.subscription.findUnique({
    where: { userId: req.userId! },
  });
  res.json({
    status: sub?.status?.toLowerCase() ?? "none",
    plan: sub?.plan?.toLowerCase() ?? null,
    expiresAt: sub?.expiresAt?.toISOString() ?? null,
    phonepeConfigured: isPhonePeConfigured(),
  });
});

export default router;
