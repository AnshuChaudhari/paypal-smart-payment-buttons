/* @flow */

import { ZalgoPromise } from '@krakenjs/zalgo-promise/src';
import { stringifyError, noop } from '@krakenjs/belter/src';
import { FUNDING, WALLET_INSTRUMENT, FPTI_KEY } from '@paypal/sdk-constants/src';

import type { MenuChoices, Wallet, WalletInstrument } from '../types';
import { getSupplementalOrderInfo, oneClickApproveOrder, getSmartWallet, loadFraudnet, updateButtonClientConfig } from '../api';
import { BUYER_INTENT, FPTI_TRANSITION, FPTI_MENU_OPTION, FPTI_STATE, HEADERS } from '../constants';
import { type ButtonProps } from '../button/props';
import { getBuyerAccessToken, getLogger, sendMetric } from '../lib';

import type { PaymentFlow, PaymentFlowInstance, SetupOptions, IsEligibleOptions, IsPaymentEligibleOptions, InitOptions, MenuOptions, Payment } from './types';
import { checkout, CHECKOUT_POPUP_DIMENSIONS, EXPERIMENTAL_POPUP_DIMENSIONS } from './checkout';

function isWalletCaptureEligible({ props, serviceData } : IsEligibleOptions) : boolean {
    const { wallet } = serviceData;
    const { onShippingChange, onShippingAddressChange, onShippingOptionsChange } = props;

    if (!wallet) {
        return false;
    }

    if (onShippingChange || onShippingAddressChange || onShippingOptionsChange) {
        return false;
    }

    return true;
}

function getClientMetadataID({ props } : {| props : ButtonProps |}) : string {
    const { clientMetadataID, sessionID } = props;
    return clientMetadataID || sessionID;
}

let smartWalletPromise;
let smartWalletErrored = false;

function setupWalletCapture({ props, config, serviceData } : SetupOptions) {
    const { env, clientID, currency, amount, userIDToken, paymentMethodToken, allowBillingPayments, branded, disableSetCookie } = props;
    const { cspNonce } = config;
    const { merchantID, wallet } = serviceData;

    const clientMetadataID = getClientMetadataID({ props });
    const queryStringParams = disableSetCookie ? { disableSetCookie } : {};
    const headers = disableSetCookie ? { [ HEADERS.DISABLE_SET_COOKIE ]: String(disableSetCookie) } : {};

    if (!wallet) {
        throw new Error(`No wallet found`);
    }

    smartWalletPromise = loadFraudnet({ env, clientMetadataID, cspNonce, queryStringParams }).catch(noop).then(() => {
        return userIDToken
            ? getSmartWallet({ clientID, merchantID, currency, amount, clientMetadataID, userIDToken, paymentMethodToken, allowBillingPayments, branded, headers})
            : wallet;
    });

    smartWalletPromise.catch(err => {
        getLogger().warn('load_smart_wallet_error', { err: stringifyError(err) });
        smartWalletErrored = true;
    });
}

function getInstrument(wallet : Wallet, fundingSource : $Values<typeof FUNDING>, instrumentID : string) : WalletInstrument {

    // $FlowFixMe
    const walletFunding = wallet[fundingSource];

    if (!walletFunding) {
        throw new Error(`Wallet has no ${ fundingSource }`);
    }

    let instrument;
    for (const inst of walletFunding.instruments) {
        if (inst.instrumentID === instrumentID) {
            instrument = inst;
        }
    }

    if (!instrument) {
        throw new Error(`Can not find instrument with id ${ instrumentID }`);
    }

    return instrument;
}

function isWalletCapturePaymentEligible({ serviceData, payment } : IsPaymentEligibleOptions) : boolean {
    const { wallet } = serviceData;
    const { win, fundingSource, instrumentID } = payment;

    if (win) {
        return false;
    }

    if (!wallet) {
        return false;
    }

    if (!instrumentID) {
        return false;
    }

    if (!smartWalletPromise) {
        return false;
    }

    if (smartWalletErrored) {
        return false;
    }

    try {
        getInstrument(wallet, fundingSource, instrumentID);
    } catch (err) {
        return false;
    }

    return true;
}

function initWalletCapture({ props, components, payment, serviceData, config, restart: fullRestart } : InitOptions) : PaymentFlowInstance {
    const { createOrder, onApprove, clientMetadataID, vault, onAuth, enableOrdersApprovalSmartWallet } = props;
    const { fundingSource, instrumentID } = payment;
    const { wallet } = serviceData;

    if (!wallet || !smartWalletPromise) {
        throw new Error(`No smart wallet found`);
    }

    if (!instrumentID) {
        throw new Error(`Instrument id required for wallet capture`);
    }

    const instrument = getInstrument(wallet, fundingSource, instrumentID);

    const planID = instrument?.planID;

    const createAccessToken = () => {
        if (!smartWalletPromise) {
            throw new Error(`No smart wallet found`);
        }

        const buyerAccessToken = getBuyerAccessToken();

        if(buyerAccessToken && enableOrdersApprovalSmartWallet) {
            return buyerAccessToken;
        }

        return smartWalletPromise.then(smartWallet => {
            const { accessToken } = getInstrument(smartWallet, fundingSource, instrumentID);

            if (!accessToken) {
                throw new Error(`Instrument access token not found`);
            }

            return accessToken;
        });
    };

    const getWebCheckoutFallback = () => {
        return checkout.init({
            props, components, serviceData, payment: {
                ...payment,
                createAccessToken,
                isClick:       false,
                buyerIntent:   BUYER_INTENT.PAY_WITH_DIFFERENT_FUNDING_SHIPPING,
                fundingSource: (instrument && instrument.type === WALLET_INSTRUMENT.CREDIT) ? FUNDING.CREDIT : fundingSource
            }, config, restart: fullRestart
        });
    };

    const fallbackToWebCheckout = () => {
        getLogger().info('web_checkout_fallback').flush();
        return getWebCheckoutFallback().start();
    };

    if (!instrument.oneClick || smartWalletErrored || (vault && !enableOrdersApprovalSmartWallet)) {
        return getWebCheckoutFallback();
    }

    const restart = () => {
        return fallbackToWebCheckout();
    };

    const shippingRequired = (orderID) => {
        return getSupplementalOrderInfo(orderID).then(order => {
            const { flags: { isChangeShippingAddressAllowed } } = order.checkoutSession;

            if (isChangeShippingAddressAllowed) {
                return true;
            }

            return false;
        });
    };

    const start = () => {
        return ZalgoPromise.hash({
            orderID:     createOrder(),
            smartWallet: smartWalletPromise
        }).then(({ orderID, smartWallet }) => {
            const buyerAccessToken = (enableOrdersApprovalSmartWallet && getBuyerAccessToken()) || getInstrument(smartWallet, fundingSource, instrumentID).accessToken;

            if (!buyerAccessToken) {
                throw new Error(`No access token available for instrument`);
            }

            const instrumentType = instrument.type;
            if (!instrumentType) {
                throw new Error(`Instrument has no type`);
            }

            const useExistingPlanning = Boolean(props.smartWalletOrderID);

            return ZalgoPromise.hash({
                requireShipping: shippingRequired(orderID),
                orderApproval:   oneClickApproveOrder({ orderID, instrumentType, buyerAccessToken, instrumentID, clientMetadataID, planID, useExistingPlanning, enableOrdersApprovalSmartWallet }),
                onAuth:          onAuth({ accessToken: buyerAccessToken })
            }).then(({ requireShipping, orderApproval }) => {
                if (requireShipping) {
                    return fallbackToWebCheckout();
                }

                const { payerID } = orderApproval;
                return onApprove({ payerID, buyerAccessToken }, { restart }).catch(noop);
                
            });
        }).catch(err => {
            getLogger().warn('approve_order_error', { err: stringifyError(err) }).flush();
            return fallbackToWebCheckout();
        });
    };

    return {
        start,
        close: () => ZalgoPromise.resolve()
    };
}



function setupWalletMenu({ props, payment, serviceData, components, config, restart, experiments } : MenuOptions) : MenuChoices {
    const dimensions = experiments?.popupIncreaseDimensions ? EXPERIMENTAL_POPUP_DIMENSIONS : CHECKOUT_POPUP_DIMENSIONS;
    const POPUP_OPTIONS = {
        width:  dimensions.WIDTH,
        height: dimensions.HEIGHT
    };
    const { createOrder, enableOrdersApprovalSmartWallet } = props;
    const { fundingSource, instrumentID } = payment;
    const { wallet, content, featureFlags } = serviceData;

    if (!wallet) {
        throw new Error(`Can not render wallet menu without wallet`);
    }

    if (!instrumentID) {
        throw new Error(`Can not render wallet menu without instrumentID`);
    }

    const instrument = getInstrument(wallet, fundingSource, instrumentID);

    if (!instrument) {
        throw new Error(`Can not render wallet menu without instrument`);
    }

    getLogger().info(`popup_dimensions_value_wallet_capture`);
    sendMetric({
        name: "pp.app.paypal_sdk.checkout_ui.dimension.count",
        dimensions: {
            spbPaymentFlow: "wallet_capture",
            fundingSource,
            dimensionType: experiments?.popupIncreaseDimensions ? 'experiment_default' : 'default',
        }
    });

    const updateMenuClientConfig = () => {
        return ZalgoPromise.try(() => {
            return createOrder();
        }).then(orderID => {
            return updateButtonClientConfig({ fundingSource, orderID, inline: false, featureFlags });
        });
    };

    const loadCheckout = ({ payment: checkoutPayment } : {| payment : Payment |}) => {
        return checkout.init({
            props, components, serviceData, config, payment: checkoutPayment, restart
        }).start();
    };

    const newFundingSource = (instrument.type === WALLET_INSTRUMENT.CREDIT)
        ? FUNDING.CREDIT
        : fundingSource;

    const CHOOSE_FUNDING_SHIPPING = {
        label:    content.payWithDifferentMethod,
        popup:    POPUP_OPTIONS,
        onSelect: ({ win }) => {

            getLogger().info('click_choose_funding').track({
                [FPTI_KEY.STATE]:           FPTI_STATE.BUTTON,
                [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.CLICK_CHOOSE_FUNDING,
                [FPTI_KEY.OPTION_SELECTED]: FPTI_MENU_OPTION.CHOOSE_FUNDING
            }).flush();

            return ZalgoPromise.try(() => {
                return updateMenuClientConfig();
            }).then(() => {
                return loadCheckout({
                    payment: {
                        ...payment,
                        win,
                        buyerIntent:       BUYER_INTENT.PAY_WITH_DIFFERENT_FUNDING_SHIPPING,
                        fundingSource:     newFundingSource,
                        createAccessToken: () => {
                            return smartWalletPromise.then(smartWallet => {
                                const buyerAccessToken = getBuyerAccessToken();
                                if(enableOrdersApprovalSmartWallet && buyerAccessToken) {
                                    return buyerAccessToken;
                                }

                                const smartInstrument = getInstrument(smartWallet, fundingSource, instrumentID);

                                if (!smartInstrument) {
                                    throw new Error(`Instrument not found`);
                                }

                                if (!smartInstrument.accessToken) {
                                    throw new Error(`Instrument access token not found`);
                                }

                                return smartInstrument.accessToken;
                            });
                        }
                    }
                });
            });
        }
    };

    const CHOOSE_ACCOUNT = {
        label:    content.payWithDifferentAccount,
        popup:    POPUP_OPTIONS,
        onSelect: ({ win }) => {

            getLogger().info('click_choose_account').track({
                [FPTI_KEY.STATE]:           FPTI_STATE.BUTTON,
                [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.CLICK_CHOOSE_ACCOUNT,
                [FPTI_KEY.OPTION_SELECTED]: FPTI_MENU_OPTION.CHOOSE_ACCOUNT
            }).flush();

            return loadCheckout({
                payment: { ...payment, win, buyerIntent: BUYER_INTENT.PAY_WITH_DIFFERENT_ACCOUNT, fundingSource: newFundingSource }
            });
        }
    };

    if (fundingSource === FUNDING.PAYPAL || fundingSource === FUNDING.CREDIT) {
        if (props.smartWalletOrderID) {
            return [CHOOSE_FUNDING_SHIPPING];
        }
        
        return [
            CHOOSE_FUNDING_SHIPPING,
            CHOOSE_ACCOUNT
        ];
    }
    
    throw new Error(`Can not render menu for ${ fundingSource }`);
}

function updateWalletClientConfig({ orderID, payment, featureFlags }) : ZalgoPromise<void> {
    const { fundingSource } = payment;
    return updateButtonClientConfig({ fundingSource, orderID, inline: true, featureFlags });
}

export const walletCapture : PaymentFlow = {
    name:                   'wallet_capture',
    setup:                  setupWalletCapture,
    isEligible:             isWalletCaptureEligible,
    isPaymentEligible:      isWalletCapturePaymentEligible,
    init:                   initWalletCapture,
    setupMenu:              setupWalletMenu,
    updateFlowClientConfig: updateWalletClientConfig,
    spinner:                true,
    inline:                 true
};
