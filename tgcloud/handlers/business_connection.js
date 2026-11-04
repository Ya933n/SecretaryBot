import { db } from 'sdk';
import { eq } from 'sdk/db';
import { app_settings } from '../schema.js';

import { OWNER_ID } from '../lib/config.js';

export default async function (business_connection) {
    const userId = String(business_connection.user.id);
    const connectionId = business_connection.id;
    const isEnabled = business_connection.is_enabled;

    // الحفظ فقط إذا كان من قام بالربط هو المالك
    if (userId === OWNER_ID) {
        if (isEnabled) {
            await db.insert(app_settings).values({ key: 'biz_connection', value: connectionId })
                  .onConflictDoUpdate({ target: app_settings.key, set: { value: connectionId } }).run();
        } else {
            await db.delete(app_settings).where(eq(app_settings.key, 'biz_connection')).run();
        }
    }
}

