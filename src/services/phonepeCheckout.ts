import axios from 'axios';
import { Env, EnvConfig } from '@phonepe-pg/pg-sdk-node';
import { config } from '../config.js';
import { getPhonePeClient } from './phonepeService.js';

type TokenClient = {
  tokenService: { getOAuthToken(): Promise<string> };
};

function phonePeEnv(): Env {
  return config.PHONEPE_ENVIRONMENT === 'PRODUCTION' ? Env.PRODUCTION : Env.SANDBOX;
}

export type PhonePePayApiResponse = {
  orderId: string;
  state: string;
  redirectUrl: string;
  expireAt: number;
};

/** Direct /checkout/v2/pay call (supports paymentModeConfig the SDK builder omits). */
export async function createPhonePeCheckoutOrder(
  body: Record<string, unknown>,
): Promise<PhonePePayApiResponse> {
  const client = getPhonePeClient() as unknown as TokenClient;
  const token = await client.tokenService.getOAuthToken();
  const base = EnvConfig.getBaseUrls(phonePeEnv()).pgHostUrl;

  try {
    const { data } = await axios.post<PhonePePayApiResponse>(`${base}/checkout/v2/pay`, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      timeout: config.PHONEPE_REQUEST_TIMEOUT * 1000,
    });

    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const responseMessage =
        responseData &&
        typeof responseData === 'object' &&
        'message' in responseData
          ? String(responseData.message)
          : typeof responseData === 'string'
            ? responseData
            : null;
      throw new Error(
        responseMessage
          ? `PhonePe checkout error: ${responseMessage}`
          : `PhonePe checkout error${error.response?.status ? ` (${error.response.status})` : ''}`,
      );
    }
    throw error;
  }
}

export function buildCheckoutPayBody(params: {
  merchantOrderId: string;
  amountPaise: number;
  redirectUrl: string;
  userId: string;
  plan: string;
  /** Sandbox: hide UPI intent (needs Paypage templates) — use Card / Net Banking simulators. */
  sandboxCardOnly: boolean;
}): Record<string, unknown> {
  const paymentFlow: Record<string, unknown> = {
    type: 'PG_CHECKOUT',
    message: 'Smittenz subscription',
  };

  if (params.redirectUrl) {
    paymentFlow.merchantUrls = { redirectUrl: params.redirectUrl };
  }

  if (params.sandboxCardOnly) {
    paymentFlow.paymentModeConfig = {
      enabledPaymentModes: [
        { type: 'CARD', cardTypes: ['DEBIT_CARD', 'CREDIT_CARD'] },
        { type: 'NET_BANKING' },
      ],
    };
  }

  return {
    merchantOrderId: params.merchantOrderId,
    amount: params.amountPaise,
    expireAfter: 1200,
    metaInfo: { udf1: params.userId, udf2: params.plan },
    paymentFlow,
  };
}
