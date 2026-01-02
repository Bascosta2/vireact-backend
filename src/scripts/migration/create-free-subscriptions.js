import mongoose from 'mongoose';
import { DB_URL } from '../../config/index.js';
import { User } from '../../model/user.model.js';
import { Subscription } from '../../model/subscription.model.js';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS } from '../../constants.js';

async function createFreeSubscriptions() {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(DB_URL);
        console.log('✅ Connected to MongoDB');

        // Get all users
        const users = await User.find({});
        console.log(`📊 Found ${users.length} users`);

        let created = 0;
        let existing = 0;

        for (const user of users) {
            // Check if subscription already exists
            const existingSubscription = await Subscription.findOne({ userId: user._id });

            if (existingSubscription) {
                console.log(`⏭️  User ${user.email} already has a subscription (${existingSubscription.plan})`);
                existing++;
                continue;
            }

            // Create FREE subscription
            const now = new Date();
            const periodEnd = new Date(now);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            const subscription = new Subscription({
                userId: user._id,
                plan: SUBSCRIPTION_PLANS.FREE,
                status: SUBSCRIPTION_STATUS.ACTIVE,
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                usage: {
                    videosUsed: 0,
                    chatMessagesUsed: 0,
                    lastResetAt: now
                }
            });

            await subscription.save();
            console.log(`✅ Created FREE subscription for user ${user.email}`);
            created++;
        }

        console.log('\n📈 Migration Summary:');
        console.log(`   - Total users: ${users.length}`);
        console.log(`   - Subscriptions created: ${created}`);
        console.log(`   - Already had subscriptions: ${existing}`);
        console.log('\n✅ Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run migration
createFreeSubscriptions();

