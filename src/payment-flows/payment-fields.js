/* @flow */

import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';
import { FUNDING } from '@paypal/sdk-constants/src';
import { memoize, querySelectorAll, debounce, noop, popup } from '@krakenjs/belter/src';

import { DATA_ATTRIBUTES, APM_LIST } from '../constants';
import { unresolvedPromise, promiseNoop, getLogger } from '../lib';
import { getConfirmOrder } from '../props/confirmOrder';

import type { PaymentFlow, PaymentFlowInstance, InitOptions } from './types';
import { checkout } from './checkout';

function setupPaymentField() {
    // pass
}
let paymentFieldsOpen = false;

export const CHECKOUT_POPUP_DIMENSIONS = {
    WIDTH:  500,
    HEIGHT: 590
};

export const CHECKOUT_APM_POPUP_DIMENSIONS = {
    WIDTH:  1282,
    HEIGHT: 720
};
function getDimensions(fundingSource : string) : {| width : number, height : number |} {
    if (APM_LIST.indexOf(fundingSource) !== -1) {
        getLogger().info(`popup_dimensions_value_${ fundingSource }`).flush();
        return { width: CHECKOUT_APM_POPUP_DIMENSIONS.WIDTH, height: CHECKOUT_APM_POPUP_DIMENSIONS.HEIGHT };
    } else {
        getLogger().info(`popup_dimensions_${ fundingSource }`).flush();
        return { width: CHECKOUT_POPUP_DIMENSIONS.WIDTH, height: CHECKOUT_POPUP_DIMENSIONS.HEIGHT };
    }
}

// function isPaymentFieldsEligible({ props, serviceData } : IsEligibleOptions) : boolean {
//     const { vault, onShippingChange, inline } = props;
//     const { eligibility } = serviceData;
//
//     if (inline) {
//         return false;
//     }
//
//     if (vault) {
//         return false;
//     }
//
//     if (onShippingChange) {
//         return false;
//     }
//
//     return eligibility.paymentFields;
// }

// function isPaymentFieldsPaymentEligible({ payment } : IsPaymentEligibleOptions) : boolean {
//     const { win, fundingSource } = payment || {};
//
//     if (win) {
//         return false;
//     }
//
//     if (fundingSource && fundingSource !== FUNDING.EPS) {
//         return false;
//     }
//
//     return true;
// }
function isPaymentFieldsEligible() : boolean {
    return true;
}

function isPaymentFieldsPaymentEligible() : boolean {
    return true;
}

function highlightCard(fundingSource : ?$Values<typeof FUNDING>) {
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

function unhighlightCards() {
    querySelectorAll(`[${ DATA_ATTRIBUTES.FUNDING_SOURCE }]`).forEach(el => {
        el.style.opacity = '1';
        el.parentElement.style.display = '';
    });
}

const getElements = (fundingSource : ?$Values<typeof FUNDING>) : {| buttonsContainer : HTMLElement, epsButtonsContainer : HTMLElement, paymentFieldsContainer : HTMLElement |} => {
    const buttonsContainer = document.querySelector('#buttons-container');
    const epsButtonsContainer = document.querySelector(`[${ DATA_ATTRIBUTES.FUNDING_SOURCE }="${ fundingSource }"]`);
    const paymentFieldsContainer = document.querySelector('#payment-fields-container');

    if (!buttonsContainer || !epsButtonsContainer || !paymentFieldsContainer) {
        throw new Error(`Did not find payment fields elements`);
    }

    return { buttonsContainer, epsButtonsContainer, paymentFieldsContainer };
};

let resizeListener;

const slideUpButtons = (fundingSource : ?$Values<typeof FUNDING>) => {
    const { buttonsContainer, epsButtonsContainer, paymentFieldsContainer } = getElements(fundingSource);

    if (!buttonsContainer || !epsButtonsContainer || !paymentFieldsContainer) {
        throw new Error(`Required elements not found`);
    }

    paymentFieldsContainer.style.minHeight = '0px';
    paymentFieldsContainer.style.display = 'block';

    const recalculateMargin = () => {
        buttonsContainer.style.marginTop = `${ buttonsContainer.offsetTop - epsButtonsContainer.offsetTop }px`;
    };

    resizeListener = debounce(() => {
        buttonsContainer.style.transitionDuration = '0s';
        recalculateMargin();
    });
    window.addEventListener('resize', resizeListener);

    recalculateMargin();
};

const slideDownButtons = (fundingSource : ?$Values<typeof FUNDING>) => {
    const { buttonsContainer } = getElements(fundingSource);

    unhighlightCards();
    window.removeEventListener('resize', resizeListener);
    buttonsContainer.style.removeProperty('transition-duration');
    buttonsContainer.style.removeProperty('margin-top');
};

function initPaymentFields({ props, components, payment, serviceData, config } : InitOptions) : PaymentFlowInstance {
    const { createOrder, onApprove, onCancel,
        locale, commit, onError, sessionID, fieldsSessionID, partnerAttributionID, buttonSessionID, onAuth  } = props;

    const { PaymentFields } = components;

    let { fundingSource, win } = payment;
    const { cspNonce } = config;
    const { buyerCountry, sdkMeta } = serviceData;

    if (paymentFieldsOpen) {
        // highlightCard(card);
        return {
            start: promiseNoop,
            close: promiseNoop
        };
    }

    const restart = memoize(() : ZalgoPromise<void> =>
        checkout.init({ props, components, payment: { ...payment, isClick: false }, serviceData, config, restart })
            .start().finally(unresolvedPromise));

    const onClose = () => {
        paymentFieldsOpen = false;
    };

    // const onCardTypeChange = ({ card: cardType }) => {
    //     highlightCard(cardType);
    // };

    let buyerAccessToken;

    const { render, close: closeCardForm } = PaymentFields({
        fundingSource,
        fieldsSessionID,
        onContinue: async (data) => {
            const orderID = await createOrder();
            return getConfirmOrder({
                orderID, payload: data, partnerAttributionID
            }, {
                facilitatorAccessToken: serviceData.facilitatorAccessToken
            }).then((response) => {
                const { width, height } = getDimensions(fundingSource);
                win = popup(`https://msmaster.qa.paypal.com/latinumcheckout/unbranded?sdkMeta=${ sdkMeta }&branded=false&fundingSource=${ fundingSource }&standaloneFundingSource=${ fundingSource }&token=${ orderID }`, { width, height });
                console.log('win', win);
                console.log('win.document', win.document);
            });
        },
        onApprove: ({ payerID, paymentID, billingToken }) => {
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
        highlightCard(fundingSource);
        return renderPromise;
    };

    const close = () => {
        slideDownButtons();
        return closeCardForm().then(() => {
            paymentFieldsOpen = false;
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
