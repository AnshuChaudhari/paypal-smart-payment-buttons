/* eslint-disable compat/compat */
/* @flow */
import type { CrossDomainWindowType } from '@krakenjs/cross-domain-utils/src';
import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';

import { type ValidatePaymentMethodResponse } from '../api';
import type { ThreeDomainSecureFlowType } from '../types';
import { TARGET_ELEMENT } from '../constants';


type CreateOrder = () => ZalgoPromise<string>;
type ThreeDomainSecureProps = {|
    ThreeDomainSecure : ThreeDomainSecureFlowType,
    createOrder : CreateOrder|void,
    getParent : () => CrossDomainWindowType,
    vaultToken? : string|null ,
    action ? : string | null,
|};
type ThreeDomainSecureContingencyProps = {|
    ThreeDomainSecure : ThreeDomainSecureFlowType,
    createOrder? : CreateOrder,
    getParent : () => CrossDomainWindowType,
    status : string,
    links : $ReadOnlyArray < {|
        method : string,
        rel : string,
        href : string
    |}>
|};

function handleThreeDomainSecureRedirect({ ThreeDomainSecure, vaultToken, createOrder, action, getParent }: ThreeDomainSecureProps): ZalgoPromise<void> {
    const promise = new ZalgoPromise();
    const instance = ThreeDomainSecure({
        vaultToken,
        createOrder,
        action,
        onSuccess: (data) => {
          return promise.resolve(data)
        },
        onCancel: () => {
          return promise.reject(new Error(`3DS cancelled`))
        },
        onError: (err) => {
          return promise.reject(err)
        }
    });

    return instance.renderTo(getParent(), TARGET_ELEMENT.BODY)
    .then(() => promise)
        .finally(instance.close);
}
const getThreeDSParams = (links) => {
    const helioslink = links.find(link => link.href.includes("helios"));
    // $FlowIssue, eslint-disable-next-line compat/compat
    const linkUrl = new URL(helioslink?.href);
    const vaultToken = linkUrl.searchParams.get("token");
    const action = linkUrl.searchParams.get("action");
    return { vaultToken, action };
}

export function handleThreeDomainSecureContingency({ status, links, ThreeDomainSecure, createOrder, getParent }: ThreeDomainSecureContingencyProps): ZalgoPromise<void> | void {
    const isWithPurchase = (link) => link.rel === "payer-action" && link.href && link.href.includes("flow=3ds");
    const isWithoutPurchase = (link) => (link.rel === "approve" && link.href.includes("helios"));

    return ZalgoPromise.try(() => {
        if (status === "PAYER_ACTION_REQUIRED" && links.some(link => isWithPurchase(link) || isWithoutPurchase(link)))
        {
            const {vaultToken, action } = getThreeDSParams(links);

        return handleThreeDomainSecureRedirect({ ThreeDomainSecure, createOrder, vaultToken, getParent, action});
        } 
    });
}

type HandleValidatePaymentMethodResponse = {|
    ThreeDomainSecure : ThreeDomainSecureFlowType,
    status : number,
    body : ValidatePaymentMethodResponse,
    createOrder : CreateOrder,
    getParent : () => CrossDomainWindowType
|};

export function handleValidatePaymentMethodResponse({ ThreeDomainSecure, status, body, createOrder, getParent }: HandleValidatePaymentMethodResponse): ZalgoPromise<void> {
    return ZalgoPromise.try(() => {
        if (status === 422 && body.links && body.links.some(link => link.rel === '3ds-contingency-resolution')) {
            return handleThreeDomainSecureRedirect({ ThreeDomainSecure, createOrder, getParent });
        }

        if (status !== 200) {

            const hasDescriptiveErrorCode = Array.isArray(body.details);
            if (hasDescriptiveErrorCode) {
                const details = body.details && body.details[0];
                const { issue = '' } = details || {};
                if (issue.trim().length !== 0) {
                    throw new Error(`Validate payment failed with issue: ${issue}`);
                }
            }

            throw new Error(`Validate payment failed with status: ${status}`);
        }
    });
}
/* eslint-enable compat/compat */