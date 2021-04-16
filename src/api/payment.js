/* @flow */

import type { ZalgoPromise } from 'zalgo-promise/src';
import { FPTI_KEY } from '@paypal/sdk-constants/src';
import { noop } from 'belter';

import { PAYMENTS_API_URL } from '../config';
import { getLogger } from '../lib';
import { FPTI_TRANSITION, FPTI_CONTEXT_TYPE, HEADERS } from '../constants';
import type { ApplePayPayment } from '../payment-flows/types';

import { callGraphQL, callRestAPI } from './api';

type PaymentAPIOptions = {|
    facilitatorAccessToken : string,
    buyerAccessToken? : ?string,
    partnerAttributionID : ?string
|};

export type PaymentCreateRequest = {|
    
|};

export type PaymentResponse = {|
    id : string,
    links : $ReadOnlyArray<{|
        method : string,
        rel : string,
        href : string
    |}>
|};

export function createPayment(payment : PaymentCreateRequest, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<PaymentResponse> {
    getLogger().info(`rest_api_create_payment_id`);

    return callRestAPI({
        accessToken: facilitatorAccessToken,
        method:      `post`,
        url:         `${ PAYMENTS_API_URL }`,
        data:        payment,
        headers:     {
            [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
        }
    }).then(body => {

        const paymentID = body && body.id;

        if (!paymentID) {
            throw new Error(`Payment Api response error:\n\n${ JSON.stringify(body, null, 4) }`);
        }

        getLogger().track({
            [FPTI_KEY.TRANSITION]:   FPTI_TRANSITION.CREATE_PAYMENT,
            [FPTI_KEY.CONTEXT_TYPE]: FPTI_CONTEXT_TYPE.PAYMENT_ID,
            [FPTI_KEY.TOKEN]:        paymentID,
            [FPTI_KEY.CONTEXT_ID]:   paymentID
        });

        return body;
    });
}

export function createPaymentID(payment : PaymentCreateRequest, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<string> {
    return createPayment(payment, { facilitatorAccessToken, partnerAttributionID })
        .then(res => res.id);
}

export function createPaymentToken(payment : PaymentCreateRequest, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<string> {
    return createPayment(payment, { facilitatorAccessToken, partnerAttributionID })
        .then(res => {
            if (res.links && res.links.length) {
                for (let i = 0; i < res.links.length; i++) {
                    if (res.links[i].method === 'REDIRECT' && res.links[i].rel === 'approval_url') {
                        const match = res.links[i].href.match(/token=((EC-)?[A-Z0-9]{17})/);
                        if (match) {
                            return match[1];
                        }
                    }
                }
            }

            throw new Error(`Could not find payment token`);
        });
}

export function getPayment(paymentID : string, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<PaymentResponse> {
    return callRestAPI({
        accessToken: facilitatorAccessToken,
        url:         `${ PAYMENTS_API_URL }/${ paymentID }`,
        headers:     {
            [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
        }
    });
}

export function executePayment(paymentID : string, payerID : string, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<PaymentResponse> {
    return callRestAPI({
        accessToken: facilitatorAccessToken,
        method:      `post`,
        url:         `${ PAYMENTS_API_URL }/${ paymentID }/execute`,
        headers:     {
            [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
        },
        data: {
            payer_id: payerID
        }
    });
}

type PatchData = {|
    
|};

export function patchPayment(paymentID : string, data : PatchData, { facilitatorAccessToken, partnerAttributionID } : PaymentAPIOptions) : ZalgoPromise<PaymentResponse> {
    const patchData = Array.isArray(data) ? { patch: data } : data;

    return callRestAPI({
        accessToken: facilitatorAccessToken,
        method:      `patch`,
        url:         `${ PAYMENTS_API_URL }/${ paymentID }`,
        data:        patchData,
        headers:     {
            [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
        }
    });
}

export function updateApplePayPayment(buyerAccessToken : string, orderID : string, applePayPayment : ApplePayPayment) : ZalgoPromise<void> {
    const { token, billingContact, shippingContact } = applePayPayment;

    return callGraphQL({
        name:    'UpdateApplePayPayment',
        headers: {
            [ HEADERS.ACCESS_TOKEN ]:   buyerAccessToken,
            [ HEADERS.CLIENT_CONTEXT ]: orderID
        },
        query: `
            mutation UpdateApplePayPayment(
                $token: ApplePayToken!
                $billingContact: ApplePayBillingContact!
                $shippingContact: ApplePayShippingContact!
            ) {
                updateApplePayPayment(
                    token: $token
                    billingContact: $billingContact
                    shippingContact: $shippingContact
                )
            }
        `,
        variables: { token, billingContact, shippingContact }
    }).then(noop);
}
