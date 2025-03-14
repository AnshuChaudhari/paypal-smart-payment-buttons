/* @flow */

import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';
import { memoize, getQueryParam, stringifyErrorMessage } from '@krakenjs/belter/src';
import { FPTI_KEY, SDK_QUERY_KEYS, INTENT, CURRENCY, FUNDING } from '@paypal/sdk-constants/src';
import { getDomain } from '@krakenjs/cross-domain-utils/src';

import { createOrderID, billingTokenToOrderID, subscriptionIdToCartId, createPaymentToken } from '../api';
import { FPTI_STATE, FPTI_TRANSITION, FPTI_CONTEXT_TYPE, FPTI_BUTTON_KEY } from '../constants';
import { getClientsideTimestamp, getLogger, isEmailAddress, sendMetric } from '../lib';
import { ENABLE_PAYMENT_API } from '../config';
import {
  vaultApprovalSessionIdToOrderId,
} from "../api/vault";

import type { CreateSubscription } from './createSubscription';
import type { CreateBillingAgreement } from './createBillingAgreement';
import type { CreateVaultSetupToken } from "./createVaultSetupToken";

export type XCreateOrderDataType = {|
    paymentSource : $Values<typeof FUNDING> | null
|};

type OrderActions = {|
    create : (Object) => ZalgoPromise<string>
|};

type PaymentActions = {|
    create : (Object) => ZalgoPromise<string>
|};

export type XCreateOrderActionsType = {|
    order : OrderActions,
    payment : ?PaymentActions
|};

export type XCreateOrder = (XCreateOrderDataType, XCreateOrderActionsType) => ZalgoPromise<string>;

export type CreateOrder = () => ZalgoPromise<string>;

export function buildXCreateOrderData({ paymentSource } : {| paymentSource : $Values<typeof FUNDING> | null |}) : XCreateOrderDataType {
    return { paymentSource };
}

type OrderOptions = {|
    facilitatorAccessToken : string,
    intent : $Values<typeof INTENT>,
    currency : $Values<typeof CURRENCY>,
    merchantID : $ReadOnlyArray<string>,
    partnerAttributionID : ?string
|};

export function buildOrderActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID } : OrderOptions) : OrderActions {
    const create = (data) => {

        let order : Object = { ...data };

        if (order.intent && order.intent.toLowerCase() !== intent) {
            throw new Error(`Unexpected intent: ${ order.intent } passed to order.create. Please ensure you are passing /sdk/js?${ SDK_QUERY_KEYS.INTENT }=${ order.intent.toLowerCase() } in the paypal script tag.`);
        }

        order = { ...order, intent: intent.toUpperCase() };

        order.purchase_units = order.purchase_units.map(unit => {
            if (unit.amount.currency_code && unit.amount.currency_code !== currency) {
                throw new Error(`Unexpected currency: ${ unit.amount.currency_code } passed to order.create. Please ensure you are passing /sdk/js?${ SDK_QUERY_KEYS.CURRENCY }=${ unit.amount.currency_code } in the paypal script tag.`);
            }

            let payee = unit.payee;

            if (merchantID && merchantID.length === 1 && merchantID[0]) {
                const payeeID = merchantID[0];

                if (isEmailAddress(payeeID)) {
                    payee = {
                        ...payee,
                        email_address: payeeID
                    };
                } else {
                    payee = {
                        ...payee,
                        merchant_id: payeeID
                    };
                }
            }

            return { ...unit, payee, amount: { ...unit.amount, currency_code: currency } };
        });

        order.application_context = order.application_context || {};

        return createOrderID(order, { facilitatorAccessToken, partnerAttributionID, forceRestAPI: false });
    };

    return { create };
}

export function buildPaymentActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID } : OrderOptions) : PaymentActions {
    const create = (data) => {

        let payment : Object = { ...data };

        const expectedIntent = (intent === INTENT.CAPTURE ? 'sale' : intent);

        if (payment.intent && payment.intent !== expectedIntent) {
            throw new Error(`Unexpected intent: ${ payment.intent } passed to order.create. Expected ${ expectedIntent }`);
        }

        payment = { ...payment, intent: expectedIntent };

        payment.transactions = payment.transactions.map(transaction => {
            if (transaction.amount.currency && transaction.amount.currency !== currency) {
                throw new Error(`Unexpected currency: ${ transaction.amount.currency } passed to order.create. Please ensure you are passing /sdk/js?${ SDK_QUERY_KEYS.CURRENCY }=${ transaction.amount.currency } in the paypal script tag.`);
            }

            let payee = transaction.payee;
            if (merchantID && merchantID.length === 1 && merchantID[0]) {
                const payeeID = merchantID[0];

                if (isEmailAddress(payeeID)) {
                    payee = {
                        ...payee,
                        email_address: payeeID
                    };
                } else {
                    payee = {
                        ...payee,
                        merchant_id: payeeID
                    };
                }
            }

            return { ...transaction, payee, amount: { ...transaction.amount, currency } };
        });

        payment.redirect_urls = payment.redirect_urls || {};
        payment.redirect_urls.return_url = payment.redirect_urls.return_url || `${ getDomain() }/checkoutnow/error`;
        payment.redirect_urls.cancel_url = payment.redirect_urls.cancel_url || `${ getDomain() }/checkoutnow/error`;
        payment.payer = payment.payer || {};
        payment.payer.payment_method = payment.payer.payment_method || 'paypal';

        return createPaymentToken(payment, { facilitatorAccessToken, partnerAttributionID });
    };

    return { create };
}

export function buildXCreateOrderActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID } : OrderOptions) : XCreateOrderActionsType {
    const order = buildOrderActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID });
    const payment = buildPaymentActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID });

    return {
        order,
        payment: ENABLE_PAYMENT_API ? payment : null
    };
}

type CreateOrderXProps = {|
    createOrder : ?XCreateOrder,
    intent : $Values<typeof INTENT>,
    currency : $Values<typeof CURRENCY>,
    merchantID : $ReadOnlyArray<string>,
    partnerAttributionID : ?string,
    paymentSource : $Values<typeof FUNDING> | null
|};

type CreateOrderProps = {|
    facilitatorAccessToken: string,
    createBillingAgreement?: ?CreateBillingAgreement,
    createSubscription?: ?CreateSubscription,
    createVaultSetupToken?: CreateVaultSetupToken,
    enableOrdersApprovalSmartWallet?: boolean,
    flow: ?string,
    smartWalletOrderID?: string,
  |};

export function getCreateOrder({ createOrder, intent, currency, merchantID, partnerAttributionID, paymentSource } : CreateOrderXProps, { facilitatorAccessToken, createBillingAgreement, createSubscription, enableOrdersApprovalSmartWallet, smartWalletOrderID, createVaultSetupToken, flow } : CreateOrderProps) : CreateOrder {
    const data = buildXCreateOrderData({ paymentSource });
    const actions = buildXCreateOrderActions({ facilitatorAccessToken, intent, currency, merchantID, partnerAttributionID });
    // this is purely for analytics purposes. We'd like to know whether
    // create order was called by a client side integration (actions.order)
    // or a server-side (all other callbacks only allow server-side)
    let integrationType = 'server-side';

    return memoize(() => {
        const queryOrderID = getQueryParam('orderID');
        if (queryOrderID) {
            return ZalgoPromise.resolve(queryOrderID);
        }

        if(enableOrdersApprovalSmartWallet && smartWalletOrderID) {
            return ZalgoPromise.resolve(smartWalletOrderID);
        }

        const startTime = Date.now();

        return ZalgoPromise.try(() => {
            if (flow === "vault_without_purchase" && createVaultSetupToken) {
                return createVaultSetupToken().then(vaultApprovalSessionIdToOrderId);
            } else if (createBillingAgreement) {
                return createBillingAgreement().then(billingTokenToOrderID);
            } else if (createSubscription) {
                return createSubscription().then(subscriptionIdToCartId);
            } else if (createOrder) {
                return createOrder(data, actions);
            } else {
                integrationType = 'client-side'          
                return actions.order.create({
                    purchase_units: [
                        {
                            amount: {
                                currency_code: currency,
                                value:         '0.01'
                            }
                        }
                    ]
                });
            }
        }).catch(err => {
            sendMetric({
                name: "pp.app.paypal_sdk.buttons.create_order.error.count",
                dimensions: {
                    errorName: 'generic',
                    flow,
                    intent,
                    integrationType
                }
            })
            getLogger()
                .error('create_order_error', { err: stringifyErrorMessage(err) })
                .track({
                    [FPTI_KEY.STATE]:      FPTI_STATE.BUTTON,
                    [FPTI_KEY.ERROR_CODE]: 'smart_buttons_create_order_error',
                    [FPTI_KEY.ERROR_DESC]: stringifyErrorMessage(err)
                });
            throw err;

        }).then(orderID => {
            if (!orderID || typeof orderID !== 'string') {
                sendMetric({
                    name: "pp.app.paypal_sdk.buttons.create_order.error.count",
                    dimensions: {
                        errorName: 'no_order_id',
                        flow,
                        intent,
                        integrationType
                    }
                })
                 getLogger()
                    .track({
                        [FPTI_KEY.STATE]:      FPTI_STATE.BUTTON,
                        [FPTI_KEY.ERROR_CODE]: 'smart_buttons_create_order_error',
                        [FPTI_KEY.ERROR_DESC]: "Expected an order id to be passed"
                    });
                throw new Error(`Expected an order id to be passed`);
            }

            if (orderID.indexOf('PAY-') === 0 || orderID.indexOf('PAYID-') === 0) {
                sendMetric({
                    name: "pp.app.paypal_sdk.buttons.create_order.error.count",
                    dimensions: {
                        errorName: 'pay_id',
                        flow,
                        intent,
                        integrationType
                    }
                })
                getLogger()
                    .track({
                        [FPTI_KEY.STATE]:      FPTI_STATE.BUTTON,
                        [FPTI_KEY.ERROR_CODE]: 'smart_buttons_create_order_error',
                        [FPTI_KEY.ERROR_DESC]: "Do not pass PAY-XXX or PAYID-XXX directly into createOrder. Pass the EC-XXX token instead"
                    });
                throw new Error(`Do not pass PAY-XXX or PAYID-XXX directly into createOrder. Pass the EC-XXX token instead`);
            }

            const duration = Date.now() - startTime;

            sendMetric({
                name: "pp.app.paypal_sdk.buttons.create_order.count",
                dimensions: {
                    flow,
                    intent,
                    integrationType
                }
            })            

            getLogger()
                .addPayloadBuilder(() => {
                    return {
                        token: orderID
                    };
                })
                .addTrackingBuilder(() => {
                    return {
                        [FPTI_KEY.CONTEXT_TYPE]: FPTI_CONTEXT_TYPE.ORDER_ID,
                        [FPTI_KEY.CONTEXT_ID]:   orderID,
                        [FPTI_KEY.TOKEN]:        orderID
                    };
                })
                .track({
                    [FPTI_KEY.STATE]:               FPTI_STATE.BUTTON,
                    [FPTI_KEY.TRANSITION]:          FPTI_TRANSITION.RECEIVE_ORDER,
                    [FPTI_KEY.EVENT_NAME]:          FPTI_TRANSITION.RECEIVE_ORDER,
                    [FPTI_KEY.CONTEXT_TYPE]:        FPTI_CONTEXT_TYPE.ORDER_ID,
                    [FPTI_BUTTON_KEY.BUTTON_WIDTH]: window.innerWidth,
                    [FPTI_KEY.CONTEXT_ID]:          orderID,
                    [FPTI_KEY.TOKEN]:               orderID,
                    [FPTI_KEY.RESPONSE_DURATION]:   duration.toString(),
                    client_time: getClientsideTimestamp()
                })
                .flush();

            return orderID;
        });
    });
}
