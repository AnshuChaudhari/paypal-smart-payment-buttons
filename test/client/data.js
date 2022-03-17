/* @flow */
/* eslint require-await: off */

import { wrapPromise } from 'belter/src';
import { FUNDING } from '@paypal/sdk-constants/src';

import {
    mockAsyncProp,
    createButtonHTML,
    DEFAULT_FUNDING_ELIGIBILITY,
    clickButton,
    mockSetupButton,
    generateOrderID
} from './mocks';

describe('callback data cases', () => {
    it('should render a button, click the button, and have the payment source in the createOrder callback data', async () => {
        return await wrapPromise(async ({ expect }) => {

            const orderID = generateOrderID();

            window.xprops.createOrder = mockAsyncProp(expect('createOrder', async (data) => {
                if (data.paymentSource && data.paymentSource === 'paypal') {
                    return orderID;
                }

                throw new Error(`Expected paymentSource to be available in createOrder data`);
            }));

            createButtonHTML();

            await mockSetupButton({
                merchantID:         [ 'XYZ12345' ],
                fundingEligibility: DEFAULT_FUNDING_ELIGIBILITY
            });

            await clickButton(FUNDING.PAYPAL);
        });
    });

    it.only('should render a button, click the button, and have the payment source in the onApprove callback data', async () => {
        return await wrapPromise(async ({ expect }) => {

            const orderID = generateOrderID();

            window.xprops.createOrder = mockAsyncProp(expect('createOrder', async (data) => {
                if (data.paymentSource && data.paymentSource === 'paypal') {
                    return orderID;
                }

                throw new Error(`Expected paymentSource to be available in createOrder data`);
            }));

            window.xprops.onApprove = mockAsyncProp(expect('onApprove', (data) => {
                if (data.paymentSource && data.paymentSource === 'paypal') {
                    return;
                }

                throw new Error(`Expected paymentSource to be available in createOrder data`);
            }));

            createButtonHTML();

            await mockSetupButton({
                merchantID:         [ 'XYZ12345' ],
                fundingEligibility: DEFAULT_FUNDING_ELIGIBILITY
            });

            await clickButton(FUNDING.PAYPAL);
        });
    });
});
