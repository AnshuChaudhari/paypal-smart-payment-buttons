/* @flow */

import { noop, stringifyError, isCrossSiteTrackingEnabled } from '@krakenjs/belter/src';
import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';
import { FPTI_KEY } from '@paypal/sdk-constants/src';

import { applepay, checkout, cardField, cardForm, paymentFields, native, vaultCapture, walletCapture, popupBridge, type Payment, type PaymentFlow } from '../payment-flows';
import { getClientsideTimestamp, getLogger, sendBeacon, sendMetric } from '../lib';
import { FPTI_TRANSITION, BUYER_INTENT, FPTI_CONTEXT_TYPE, FPTI_CUSTOM_KEY, FPTI_STATE } from '../constants';
import { updateButtonClientConfig } from '../api';
import { getConfirmOrder } from '../props/confirmOrder';
import { enableVaultSetup } from '../middleware';
import { type Experiments } from '../types';

import { type ButtonProps, type Config, type ServiceData, type Components } from './props';
import { enableLoadingSpinner, disableLoadingSpinner } from './dom';
import { validateOrder } from './validation';
import { showButtonSmartMenu } from './menu';

const PAYMENT_FLOWS : $ReadOnlyArray<PaymentFlow> = [
    vaultCapture,
    walletCapture,
    cardField,
    cardForm,
    paymentFields,
    popupBridge,
    applepay,
    native,
    checkout
];

export function setupPaymentFlows({ props, config, serviceData, components } : {| props : ButtonProps, config : Config, serviceData : ServiceData, components : Components |}) : ZalgoPromise<void> {
    return ZalgoPromise.all(PAYMENT_FLOWS.map(flow => {
        return flow.isEligible({ props, config, serviceData })
            ? flow.setup({ props, config, serviceData, components })
            : null;
    })).then(noop);
}

export function getPaymentFlow({ props, payment, config, serviceData } : {| props : ButtonProps, payment : Payment, config : Config, components : Components, serviceData : ServiceData |}) : PaymentFlow {
    if (!props.fundingSource && payment.fundingSource) {
        props.fundingSource = payment.fundingSource;
    }

    for (const flow of PAYMENT_FLOWS) {
        if (flow.isEligible({ props, config, serviceData }) && flow.isPaymentEligible({ props, payment, config, serviceData })) {
            return flow;
        }
    }

    throw new Error(`Could not find eligible payment flow`);
}

const sendPersonalizationBeacons = (personalization) => {
    if (personalization && personalization.tagline && personalization.tagline.tracking) {
        sendBeacon(personalization.tagline.tracking.click);
    }
    if (personalization && personalization.buttonText && personalization.buttonText.tracking) {
        sendBeacon(personalization.buttonText.tracking.click);
    }
};

type InitiatePaymentOptions = {|
    payment : Payment,
    props : ButtonProps,
    serviceData : ServiceData,
    config : Config,
    components : Components,
    experiments? : Experiments
|};

export function initiatePaymentFlow({ payment, serviceData, config, components, props, experiments } : InitiatePaymentOptions) : ZalgoPromise<void> {
    const { button, fundingSource, instrumentType, buyerIntent } = payment;
    const buttonLabel = props.style?.label;

    return ZalgoPromise.try(() => {
        const { merchantID, personalization, fundingEligibility, buyerCountry, featureFlags } = serviceData;
        const { clientID, onClick, createOrder, env, vault, partnerAttributionID, userExperienceFlow, buttonSessionID, intent, currency,
            clientAccessToken, createBillingAgreement, createSubscription, commit, disableFunding, disableCard, userIDToken, enableNativeCheckout } = props;

        sendPersonalizationBeacons(personalization);

        const restart = ({ payment: restartPayment }) =>
            initiatePaymentFlow({ payment: restartPayment, serviceData, config, components, props });

        const { name, init, inline, spinner, updateFlowClientConfig } = getPaymentFlow({ props, payment, config, components, serviceData });
        const { click, start, close } = init({ props, config, serviceData, components, payment, restart, experiments });

        sendMetric({
            name: 'pp.app.paypal_sdk.buttons.click.count',
            dimensions: {
                fundingSource,
                spbPaymentFlow: name,
        }});

        getLogger()
            .addPayloadBuilder(() => {
                return { token: null };
            })
            .addTrackingBuilder(() => {
                return {
                    [FPTI_KEY.CHOSEN_FUNDING]:     fundingSource,
                    [FPTI_KEY.CONTEXT_TYPE]:       FPTI_CONTEXT_TYPE.BUTTON_SESSION_ID,
                    [FPTI_KEY.CONTEXT_ID]:         buttonSessionID,
                    [FPTI_KEY.BUTTON_SESSION_UID]: buttonSessionID,
                };
            })
            .info(`button_click_pay_flow_${ name }`)
            .info(`button_click_fundingsource_${ fundingSource }`)
            .info(`button_click_instrument_${ instrumentType || 'default' }`)
            .info(`cross_site_tracking_${ isCrossSiteTrackingEnabled('enforce_policy') ? 'enabled' : 'disabled' }`)
            .track({
                [FPTI_KEY.STATE]:             FPTI_STATE.BUTTON,
                [FPTI_KEY.TRANSITION]:        FPTI_TRANSITION.BUTTON_CLICK,
                [FPTI_KEY.EVENT_NAME]:        FPTI_TRANSITION.BUTTON_CLICK,
                [FPTI_KEY.CHOSEN_FI_TYPE]:    instrumentType,
                [FPTI_KEY.PAYMENT_FLOW]:      name,
                [FPTI_KEY.IS_VAULT]:          instrumentType ? '1' : '0',
                [FPTI_CUSTOM_KEY.INFO_MSG]:   enableNativeCheckout ? 'tester' : '',
                client_time: getClientsideTimestamp()
            })
            .track({
                [FPTI_KEY.STATE]:      FPTI_STATE.BUTTON,
                [FPTI_KEY.TRANSITION]: `cross_site_tracking_${ isCrossSiteTrackingEnabled('enforce_policy') ? 'enabled' : 'disabled' }`
            })
            .flush();

        const loggingPromise =  ZalgoPromise.try(() => {
            return window.xprops.sessionState.get(`__confirm_${ fundingSource }_payload__`).then(confirmPayload => {
                const fieldsSessionID = confirmPayload ? confirmPayload.payment_source[fundingSource].metadata.fieldsSessionID : '';
                getLogger()
                    .addTrackingBuilder(() => {
                        return {
                            [FPTI_KEY.FIELDS_COMPONENT_SESSION_ID]: fieldsSessionID
                        };
                    });
            });
        });

        const clickPromise = click ? ZalgoPromise.try(click) : ZalgoPromise.resolve();
        clickPromise.catch(noop);

        return ZalgoPromise.try(() => {
            return onClick ? onClick({ fundingSource }) : true;
        }).then(valid => {
            return valid ? clickPromise : false;
        }).then(valid => {
            if (valid === false) {
                return;
            }

            if (spinner) {
                enableLoadingSpinner(button);
            }

            const updateClientConfigPromise = createOrder().then(orderID => {
                if (updateFlowClientConfig) {
                    return updateFlowClientConfig({ orderID, payment, userExperienceFlow, buttonSessionID, featureFlags });
                }

                function updateButtonClientConfigWrapper() : ZalgoPromise<void> {
                    return updateButtonClientConfig({ orderID, fundingSource, inline, userExperienceFlow, featureFlags }).catch(err => {
                        getLogger().error('update_client_config_error', { err: stringifyError(err) });
                    });
                }

                // feature flag to control blocking/non-blocking behavior
                if (featureFlags.isButtonClientConfigCallBlocking) {
                    return updateButtonClientConfigWrapper();
                } else {
                    // non-blocking call by default
                    updateButtonClientConfigWrapper();
                }
            }).catch(noop);

            const vaultPromise = createOrder().then(orderID => {
                return ZalgoPromise.try(() => {
                    if (clientID && buyerIntent === BUYER_INTENT.PAY) {
                        return enableVaultSetup({ orderID, vault, clientAccessToken, fundingEligibility, fundingSource, createBillingAgreement, createSubscription,
                            clientID, merchantID, buyerCountry, currency, commit, intent, disableFunding, disableCard, userIDToken, userExperienceFlow, buttonSessionID, inline });
                    }
                });
            });

            const startPromise = updateClientConfigPromise.then(() => {
                if (featureFlags.isButtonClientConfigCallBlocking) {
                    getLogger().info('blocking_cco_call_resolved', {time: getClientsideTimestamp(), fundingSource, buttonSessionID});
                } else {
                    getLogger().info('non_blocking_cco_call_resolved', {time: getClientsideTimestamp(), fundingSource, buttonSessionID});
                }

                return start();
            });

            const validateOrderPromise = createOrder().then(orderID => {
                return validateOrder(orderID, {
                    env,
                    merchantID,
                    intent,
                    currency,
                    vault,
                    buttonLabel,
                    featureFlags: serviceData.featureFlags
                });
            });

            const confirmOrderPromise = createOrder().then((orderID) => {
                return window.xprops.sessionState.get(
                    `__confirm_${ fundingSource }_payload__`
                ).then(confirmOrderPayload => {
                    if (!confirmOrderPayload) {
                        // skip the confirm call when there is no confirm payload (regular flow).
                        return;
                    }

                    return getConfirmOrder({
                        orderID, payload: confirmOrderPayload, partnerAttributionID
                    }, {
                        facilitatorAccessToken: serviceData.facilitatorAccessToken
                    });
                });
            });

            return ZalgoPromise.all([
                loggingPromise,
                updateClientConfigPromise,
                clickPromise,
                vaultPromise,
                validateOrderPromise,
                startPromise,
                confirmOrderPromise
            ]).catch(err => {
                return ZalgoPromise.try(close).then(() => {
                    throw err;
                });
            }).then(() => {
                if (featureFlags.isButtonClientConfigCallBlocking) {
                    getLogger().info('redirect_to_xorouter_blocking_cco', {time: getClientsideTimestamp(), fundingSource, buttonSessionID});
                } else {
                    getLogger().info('redirect_to_xorouter_non_blocking_cco', {time: getClientsideTimestamp(), fundingSource, buttonSessionID});
                }
            })
        });

    }).finally(() => {
        disableLoadingSpinner(button);
    });
}

type InitiateMenuOptions = {|
    payment : Payment,
    props : ButtonProps,
    serviceData : ServiceData,
    config : Config,
    components : Components,
    experiments? : Experiments
|};

export function initiateMenuFlow({ payment, serviceData, config, components, props, experiments } : InitiateMenuOptions) : ZalgoPromise<void> {
    return ZalgoPromise.try(() => {
        const { fundingSource, button } = payment;

        const { name, setupMenu } = getPaymentFlow({ props, payment, config, components, serviceData });

        if (!setupMenu) {
            throw new Error(`${ name } does not support menu`);
        }

        getLogger().info(`menu_click`).info(`pay_flow_${ name }`).track({
            [FPTI_KEY.STATE]:          FPTI_STATE.BUTTON,
            [FPTI_KEY.TRANSITION]:     FPTI_TRANSITION.MENU_CLICK,
            [FPTI_KEY.CHOSEN_FUNDING]: fundingSource,
            [FPTI_KEY.PAYMENT_FLOW]:   name
        }).flush();

        const restart = ({ payment: restartPayment }) =>
            initiatePaymentFlow({ payment: restartPayment, serviceData, config, components, props });

        const choices = setupMenu({ props, payment, serviceData, components, config, restart, experiments }).map(choice => {
            return {
                ...choice,
                onSelect: (...args) => {
                    if (choice.spinner) {
                        enableLoadingSpinner(button);
                    }

                    return ZalgoPromise.try(() => {
                        return choice.onSelect(...args);
                    }).then(() => {
                        if (choice.spinner) {
                            disableLoadingSpinner(button);
                        }
                    });
                }
            };
        });

        return showButtonSmartMenu({ props, payment, components, choices });
    });
}
