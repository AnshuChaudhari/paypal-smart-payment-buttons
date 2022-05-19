/* @flow */
import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';
import { FUNDING } from '@paypal/sdk-constants/src';
import { memoize, querySelectorAll, debounce, noop } from '@krakenjs/belter/src';
import { getParent } from '@krakenjs/cross-domain-utils/src';
import { EXPERIENCE } from '@paypal/checkout-components/src/constants/button';

import { DATA_ATTRIBUTES, TARGET_ELEMENT, INLINE_PAYMENT_FIELDS_APM_LIST } from '../constants';
import { unresolvedPromise, promiseNoop } from '../lib';
import { getConfirmOrder } from '../props';

import type { PaymentFlow, PaymentFlowInstance, IsEligibleOptions, IsPaymentEligibleOptions, InitOptions } from './types';

function setupPaymentField() {
    // pass
}
let paymentFieldsOpen = false;
function isPaymentFieldsEligible({ props } : IsEligibleOptions) : boolean {
    const { vault, onShippingChange, experience } = props;

    if (experience === EXPERIENCE.INLINE) {
        return false;
    }

    if (vault) {
        return false;
    }

    if (onShippingChange) {
        return false;
    }

    return true;
}

function isPaymentFieldsPaymentEligible({ payment } : IsPaymentEligibleOptions) : boolean {
    const { win, fundingSource } = payment || {};

    if (win) {
        return false;
    }

    if (fundingSource && !INLINE_PAYMENT_FIELDS_APM_LIST.includes(fundingSource)) {
        return false;
    }

    return true;
}

function highlightFundingSource(fundingSource : ?$Values<typeof FUNDING>) {
    if (!fundingSource) {
        return;
    }
    querySelectorAll(`[${ DATA_ATTRIBUTES.FUNDING_SOURCE }]`).forEach(el => {
        if (el.getAttribute(DATA_ATTRIBUTES.FUNDING_SOURCE) === fundingSource.toLowerCase()) {
            el.style.opacity = '1';
        } else {
            el.style.display = 'none';
            el.parentElement.style.display = 'none';
            el.style.opacity = '0.1';
        }
    });
}

function unhighlightFundingSources() {
    querySelectorAll(`[${ DATA_ATTRIBUTES.FUNDING_SOURCE }]`).forEach(el => {
        el.style.opacity = '1';
        el.parentElement.style.display = '';
    });
}

const getElements = (fundingSource : ?$Values<typeof FUNDING>) : {| buttonsContainer : HTMLElement, fundingSourceButtonsContainer : HTMLElement, paymentFieldsContainer : HTMLElement |} => {
    const buttonsContainer = document.querySelector('#buttons-container');
    const fundingSourceButtonsContainer = document.querySelector(`[${ DATA_ATTRIBUTES.FUNDING_SOURCE }="${ fundingSource }"]`);
    const paymentFieldsContainer = document.querySelector('#payment-fields-container');

    if (!buttonsContainer || !fundingSourceButtonsContainer || !paymentFieldsContainer) {
        throw new Error(`Did not find payment fields elements`);
    }

    return { buttonsContainer, fundingSourceButtonsContainer, paymentFieldsContainer };
};

let resizeListener;

const slideUpButtons = (fundingSource : ?$Values<typeof FUNDING>) => {
    const { buttonsContainer, fundingSourceButtonsContainer, paymentFieldsContainer } = getElements(fundingSource);

    if (!buttonsContainer || !fundingSourceButtonsContainer || !paymentFieldsContainer) {
        throw new Error(`Required elements not found`);
    }

    paymentFieldsContainer.style.minHeight = '0px';
    paymentFieldsContainer.style.display = 'block';

    const recalculateMargin = () => {
        buttonsContainer.style.marginTop = `${ buttonsContainer.offsetTop - fundingSourceButtonsContainer.offsetTop }px`;
    };

    resizeListener = debounce(() => {
        buttonsContainer.style.transitionDuration = '0s';
        recalculateMargin();
    });
    window.addEventListener('resize', resizeListener);

    recalculateMargin();
};

const slideDownButtons = () => {
    const buttonsContainer = document.querySelector('#buttons-container');
    unhighlightFundingSources();
    window.removeEventListener('resize', resizeListener);
    buttonsContainer.style.removeProperty('transition-duration');
    buttonsContainer.style.removeProperty('margin-top');
};
function initPaymentFields({ props, components, payment, serviceData, config } : InitOptions) : PaymentFlowInstance {
    const { createOrder, onApprove, onCancel,
        locale, commit, onError, sessionID, fieldsSessionID, partnerAttributionID, buttonSessionID, onAuth  } = props;
    const { PaymentFields, Checkout } = components;
    const { fundingSource } = payment;
    const { cspNonce } = config;
    const { buyerCountry, sdkMeta } = serviceData;
    if (paymentFieldsOpen) {
        highlightFundingSource(fundingSource);
        return {
            start: promiseNoop,
            close: promiseNoop
        };
    }
    const restart = memoize(() : ZalgoPromise<void> => {
        // eslint-disable-next-line no-use-before-define
        return close().finally(() => {
            return initPaymentFields({ props, components, serviceData, config, payment: { ...payment }, restart })
                .start().finally(unresolvedPromise);
        });
    });

    const onClose = () => {
        paymentFieldsOpen = false;
    };

    let buyerAccessToken;
    let checkout;
    const { render, close: closeCardForm } = PaymentFields({
        fundingSource,
        fieldsSessionID,
        onContinue: async (data) => {
            const orderID = await createOrder();
            return getConfirmOrder({
                orderID, payload: data, partnerAttributionID
            }, {
                facilitatorAccessToken: serviceData.facilitatorAccessToken
            }).then(() => {
                checkout = Checkout({
                    ...props,
                    onClose: () => {
                        // eslint-disable-next-line no-use-before-define
                        return close().then(() => {
                            return onCancel();
                        });
                    },
                    sdkMeta,
                    branded: false,
                    standaloneFundingSource: fundingSource,
                    inlinexo: false,
                    onApprove:     ({ payerID, paymentID, billingToken }) => {
                        // eslint-disable-next-line no-use-before-define
                        return close().then(() => {
                            return onApprove({ payerID, paymentID, billingToken, buyerAccessToken }, { restart }).catch(noop);
                        });
                    },
                    onAuth: ({ accessToken }) => {
                        const access_token = accessToken ? accessToken : buyerAccessToken;
                        return onAuth({ accessToken: access_token }).then(token => {
                            buyerAccessToken = token;
                        });
                    },
                    onCancel: () => {
                        // eslint-disable-next-line no-use-before-define
                        return close().then(() => {
                            return onCancel();
                        });
                    }
                });
                checkout.renderTo(getParent(window), TARGET_ELEMENT.BODY);
            });
        },
        onError,
        onClose,
        sessionID,
        buttonSessionID,
        buyerCountry,
        locale,
        commit,
        cspNonce
    });
    const start = () => {
        paymentFieldsOpen = true;
        const renderPromise = render('#payment-fields-container');
        slideUpButtons(fundingSource);
        highlightFundingSource(fundingSource);
        return renderPromise;
    };
    const close = () => {
        return closeCardForm().then(() => {
            paymentFieldsOpen = false;
            checkout.close();
            slideDownButtons(fundingSource);
        });
    };
    return { start, close };
}
export const paymentFields : PaymentFlow = {
    name:              'payment_fields',
    setup:             setupPaymentField,
    isEligible:        isPaymentFieldsEligible,
    isPaymentEligible: isPaymentFieldsPaymentEligible,
    init:              initPaymentFields,
    inline:            true
};
