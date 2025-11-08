// ========== 1. การตั้งค่าที่ปลอดภัย ==========
// ดึงค่าจาก Script Properties
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
const SECRET_SALT = PropertiesService.getScriptProperties().getProperty('SECRET_SALT');

const CONFIG = {
  SHEET_NAMES: {
    MAIN_DATA: 'ข้อมูลระบบ',
    USERS: 'ผู้ใช้งาน',
    CHEMICALS: 'สารเคมี',
    EQUIPMENT: 'อุปกรณ์',
    BORROWS: 'การยืม-คืน',
    REPORTS: 'รายงาน', // (Issue Reports)
    LOGS: 'บันทึกการใช้งาน'
  }
};

// ========== 2. ฟังก์ชันหลัก (Router) ==========
function doPost(e) {
  let response;
  try {
    const request = JSON.parse(e.postData.contents);
    const { action, data, user } = request; // รับ 'user' ที่ Client ส่งมา (หลัง Login)

    console.log('📨 Received POST:', { action, user: user ? user.username : 'guest' });

    // === การตรวจสอบสิทธิ์ (Authorization) ===
    if (action === 'login') {
       // ปล่อยผ่าน
    } 
    // Action ที่ต้องเป็น Admin
    else if (['createUser', 'deleteUser', 'resolveIssue', 'getAdminData'].includes(action)) {
      if (!user || user.role !== 'admin') {
        throw new Error('Permission denied. Admin access required.');
      }
    }
    // Action ที่ต้อง Login (Admin หรือ Teacher)
    else {
      if (!user) {
        throw new Error('Permission denied. User not logged in.');
      }
    }
    // ======================================

    // ใช้ LockService สำหรับทุก Action ที่แก้ไขข้อมูลเพื่อป้องกัน Race Condition
    const lock = LockService.getScriptLock();
    lock.waitLock(15000); // พยายามจองสิทธิ์ 15 วินาที

    try {
      switch (action) {
        // --- ระบบผู้ใช้ (ปลอดภัย) ---
        case 'login':
          response = handleLogin(data.username, data.password); // Login ไม่ต้อง Lock
          break;
        case 'createUser':
          response = handleCreateUser(data); 
          break;
        case 'updateUser':
          response = handleUpdateUser(data);
          break;

        // --- ระบบข้อมูล (ปลอดภัย) ---
        case 'getInitialData':
          response = handleGetInitialData(user); // อ่านข้อมูล ไม่ต้อง Lock
          break;
        
        // --- ระบบสต็อก (Atomic - ปลอดภัย) ---
        case 'borrowItem':
          response = handleBorrowItem(data, user);
          break;
        case 'returnItem':
          response = handleReturnItem(data, user);
          break;
        case 'reportIssue': // (out_of_stock, damaged)
          response = handleReportIssue(data, user);
          break;
        case 'resolveIssue': // (restock, repair)
          response = handleResolveIssue(data, user);
          break;

        // --- CRUD ทั่วไป ---
        case 'create':
          response = handleCreate(data, user);
          break;
        case 'update':
          response = handleUpdate(data, user);
          break;
        case 'delete':
          response = handleDelete(data, user);
          break;
        
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } finally {
      if (action !== 'login' && action !== 'getInitialData') {
         lock.releaseLock(); // คืน Lock
      }
    }

    return createJsonResponse({ status: 'success', data: response });

  } catch (error) {
    console.error('❌ Error in doPost:', error);
    return createJsonResponse({ status: 'error', message: error.toString() });
  }
}

// ========== 3. ฟังก์ชันระบบผู้ใช้ (ปลอดภัย) ==========

function hashPassword(password) {
  if (!SECRET_SALT) throw new Error('SECRET_SALT is not defined.');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + SECRET_SALT);
  return digest.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function handleLogin(username, password) {
  console.log('🔐 Login attempt:', username);
  
  // (สร้าง Admin account ถ้ายังไม่มี)
  initializeDefaultAdmin();

  const hashedPassword = hashPassword(password);
  
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const allData = readAllFromMainSheet(mainSheet);
  
  const users = allData.filter(item => item.type === 'user');
  const user = users.find(u => u.username === username);

  if (!user) {
     logActivity('LOGIN', 'failed', username, { reason: 'User not found' });
     throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }

  if (user.passwordHash !== hashedPassword) {
     logActivity('LOGIN', 'failed', username, { reason: 'Wrong password' });
     throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  
  logActivity('LOGIN', 'success', user.username, {});
  
  delete user.passwordHash; // *** ห้ามส่ง Hash กลับไปเด็ดขาด ***
  
  return { success: true, user: user };
}

function handleCreateUser(data) {
  if (!data.password || data.password.length < 6) {
    throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  }
  
  const hashedPassword = hashPassword(data.password);
  
  const newUser = {
    id: data.id || 'user-' + Date.now(),
    type: 'user',
    username: data.username,
    firstName: data.firstName,
    lastName: data.lastName,
    role: data.role || 'teacher',
    passwordHash: hashedPassword,
    createdAt: new Date().toISOString()
  };
  
  // ตรวจสอบ Username ซ้ำ
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const users = readAllFromMainSheet(mainSheet).filter(i => i.type === 'user');
  if (users.some(u => u.username === newUser.username)) {
    throw new Error('ชื่อผู้ใช้งานนี้ถูกใช้ไปแล้ว');
  }

  return handleCreate(newUser, { username: 'admin' });
}

function handleUpdateUser(data) {
  const updatedUser = data;
  
  if (updatedUser.password) {
    if (updatedUser.password.length < 6) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    updatedUser.passwordHash = hashPassword(updatedUser.password);
    delete updatedUser.password; // ลบ Plain text
  }
  
  return handleUpdate(updatedUser, { username: 'admin' });
}

function initializeDefaultAdmin() {
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const allData = readAllFromMainSheet(mainSheet);
  const adminExists = allData.some(item => item.type === 'user' && item.username === 'admin');

  if (!adminExists) {
    console.log('👤 No admin found, creating default admin...');
    const adminUser = {
      id: 'admin-' + Date.now(),
      type: 'user',
      username: 'admin',
      firstName: 'ผู้ดูแล',
      lastName: 'ระบบ',
      role: 'admin',
      passwordHash: hashPassword('admin123'), // admin123 (Hashed)
      createdAt: new Date().toISOString()
    };
    handleCreate(adminUser, { username: 'system' });
    console.log('✅ Default admin created.');
  }
}

// ========== 4. ฟังก์ชันดึงข้อมูล (ปลอดภัย) ==========
function handleGetInitialData(user) {
  console.log(`🔄 Getting initial data for: ${user.username} (Role: ${user.role})`);
  
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const allData = readAllFromMainSheet(mainSheet);

  // 1. กรองข้อมูลพื้นฐาน
  const chemicals = allData.filter(item => item.type === 'chemical');
  const equipment = allData.filter(item => item.type === 'equipment');
  
  let responseData = [...chemicals, ...equipment];
  
  // 2. เพิ่มข้อมูลตามสิทธิ์
  if (user.role === 'admin') {
    const users = allData.filter(item => item.type === 'user').map(u => {
      delete u.passwordHash;
      return u;
    });
    const borrows = allData.filter(item => item.type === 'borrow');
    const reports = allData.filter(item => item.type === 'issue_report');
    responseData.push(...users, ...borrows, ...reports);
    
  } else if (user.role === 'teacher') {
    const myBorrows = allData.filter(item => item.type === 'borrow' && item.borrower === user.username);
    const myReports = allData.filter(item => item.type === 'issue_report' && item.reportedBy === user.username);
    responseData.push(...myBorrows, ...myReports);
  }
  
  return responseData;
}

// ========== 5. ฟังก์ชันสต็อก (Atomic) ==========

function handleBorrowItem(data, user) {
  const { itemId, amount, room } = data;
  if (!itemId || !amount || !room || amount <= 0) throw new Error('ข้อมูลการยืมไม่ถูกต้อง');
  
  console.log(`⚡ [Locked] ${user.username} is borrowing ${amount} of ${itemId}`);
  
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const itemRowIndex = findRowByIdInSheet(mainSheet, itemId);
  if (itemRowIndex < 0) throw new Error('ไม่พบรายการ');
  
  // 1. อ่านข้อมูล Item
  const item = JSON.parse(mainSheet.getRange(itemRowIndex, 3).getValue());
  
  // 2. ตรวจสอบสต็อก
  const currentQuantity = parseFloat(item.quantity) || 0;
  if (currentQuantity < amount) {
    throw new Error(`สต็อกไม่เพียงพอ (คงเหลือ: ${currentQuantity})`);
  }
  
  // 3. คำนวณและอัปเดตสต็อก
  item.quantity = currentQuantity - amount;
  handleUpdate(item, user); // (handleUpdate จะเรียก log และอัปเดตชีตเฉพาะ)
  
  // 4. สร้างรายการยืม
  const borrowRecord = {
    id: 'borrow-' + Date.now(),
    type: 'borrow',
    borrower: user.username,
    itemId: itemId,
    itemName: item.name,
    itemType: item.type,
    amount: amount,
    room: room,
    borrowDate: new Date().toISOString(),
    status: 'pending'
  };
  handleCreate(borrowRecord, user);
  
  logActivity('BORROW', item.type, itemId, { user: user.username, amount, newStock: item.quantity });
  
  return { updatedItem: item, newBorrow: borrowRecord };
}

function handleReturnItem(data, user) {
  const { borrowId, returnAmount } = data;
  if (!borrowId || returnAmount < 0) throw new Error('ข้อมูลการคืนไม่ถูกต้อง');
  
  console.log(`⚡ [Locked] ${user.username} is returning borrowId ${borrowId}`);
  
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  
  // 1. หา Borrow Record
  const borrowRowIndex = findRowByIdInSheet(mainSheet, borrowId);
  if (borrowRowIndex < 0) throw new Error('ไม่พบรายการยืม');
  
  const borrow = JSON.parse(mainSheet.getRange(borrowRowIndex, 3).getValue());
  if (borrow.status === 'returned') throw new Error('รายการนี้ถูกคืนไปแล้ว');
  
  // 2. อัปเดต Borrow Record
  borrow.status = 'returned';
  borrow.returnDate = new Date().toISOString();
  borrow.actualReturnAmount = returnAmount;
  handleUpdate(borrow, user);
  
  // 3. คืนสต็อก
  const itemId = borrow.itemId;
  const itemRowIndex = findRowByIdInSheet(mainSheet, itemId);
  if (itemRowIndex > 0) {
    const item = JSON.parse(mainSheet.getRange(itemRowIndex, 3).getValue());
    item.quantity = (parseFloat(item.quantity) || 0) + parseFloat(returnAmount);
    handleUpdate(item, user);
    logActivity('RETURN', item.type, itemId, { user: user.username, amount: returnAmount, newStock: item.quantity });
    return { updatedBorrow: borrow, updatedItem: item };
  }
  
  return { updatedBorrow: borrow };
}

function handleReportIssue(data, user) {
  const { itemId, issueType, amount, note, borrowId } = data;
  console.log(`⚡ [Locked] ${user.username} reporting issue: ${issueType} for ${itemId}`);

  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);

  // 1. หา Item
  const itemRowIndex = findRowByIdInSheet(mainSheet, itemId);
  if (itemRowIndex < 0) throw new Error('ไม่พบรายการ');
  const item = JSON.parse(mainSheet.getRange(itemRowIndex, 3).getValue());
  
  // 2. สร้าง Issue Report
  const issueReport = {
    id: 'issue-' + Date.now(),
    type: 'issue_report',
    itemId: itemId,
    itemName: item.name,
    itemType: item.type,
    issueType: issueType, // 'out_of_stock' หรือ 'damaged'
    reportedBy: user.username,
    reportDate: new Date().toISOString(),
    status: 'reported',
    note: note,
    [issueType === 'damaged' ? 'damagedAmount' : 'originalAmount']: amount
  };

  // 3. ถ้าแจ้งจากหน้ารายการยืม ให้อัปเดตการยืมด้วย
  if (borrowId) {
    const borrowRowIndex = findRowByIdInSheet(mainSheet, borrowId);
    if (borrowRowIndex > 0) {
      const borrow = JSON.parse(mainSheet.getRange(borrowRowIndex, 3).getValue());
      const remainingAmount = Math.max(0, borrow.amount - amount);
      borrow.amount = remainingAmount; // ลดจำนวนยืมที่ต้องคืน
      borrow.issueReported = true;
      borrow.issueAmount = amount;
      handleUpdate(borrow, user);
      issueReport.borrowId = borrowId; // เชื่อมโยง report กับการยืม
    }
  } else {
    // 4. ถ้าแจ้งจากหน้าหลัก ให้หักสต็อกเลย
    if (issueType === 'damaged') {
      item.damagedQuantity = (parseFloat(item.damagedQuantity) || 0) + parseFloat(amount);
      item.quantity = Math.max(0, (parseFloat(item.quantity) || 0) - parseFloat(amount));
    } else { // out_of_stock
      item.quantity = Math.max(0, (parseFloat(item.quantity) || 0) - parseFloat(amount));
    }
    handleUpdate(item, user);
  }
  
  handleCreate(issueReport, user); // บันทึก Report
  return { issueReport, updatedItem: item };
}

function handleResolveIssue(data, user) {
  const { reportId, actionAmount, note } = data; // actionAmount คือ จำนวนที่เติม หรือ ซ่อม
  console.log(`⚡ [Locked] ${user.username} resolving issue: ${reportId}`);

  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);

  // 1. หา Report
  const reportRowIndex = findRowByIdInSheet(mainSheet, reportId);
  if (reportRowIndex < 0) throw new Error('ไม่พบรายงานปัญหา');
  const report = JSON.parse(mainSheet.getRange(reportRowIndex, 3).getValue());
  if (report.status === 'resolved') throw new Error('ปัญหานี้ถูกแก้ไขแล้ว');

  // 2. หา Item
  const itemRowIndex = findRowByIdInSheet(mainSheet, report.itemId);
  if (itemRowIndex < 0) throw new Error('ไม่พบรายการ (Item) ที่เกี่ยวข้อง');
  const item = JSON.parse(mainSheet.getRange(itemRowIndex, 3).getValue());

  // 3. อัปเดตสถานะ Report
  report.status = 'resolved';
  report.resolvedDate = new Date().toISOString();
  report.resolvedNote = note;
  report.resolvedBy = user.username;

  // 4. อัปเดต Item Stock
  if (report.issueType === 'out_of_stock') { // เติมสต็อก
    item.quantity = (parseFloat(item.quantity) || 0) + parseFloat(actionAmount);
    report.restockAmount = actionAmount;
  } else if (report.issueType === 'damaged') { // ซ่อม
    item.quantity = (parseFloat(item.quantity) || 0) + parseFloat(actionAmount);
    item.damagedQuantity = Math.max(0, (parseFloat(item.damagedQuantity) || 0) - parseFloat(actionAmount));
    report.repairedAmount = actionAmount;
  }
  
  handleUpdate(report, user);
  handleUpdate(item, user);

  logActivity('RESOLVE', report.issueType, report.itemId, { user: user.username, amount: actionAmount });
  return { updatedReport: report, updatedItem: item };
}

// ========== 6. ฟังก์ชัน CRUD (ปลอดภัย) ==========

function handleCreate(data, user) {
  console.log(`➕ ${user.username} creating:`, data.type, data.id);
  const spreadsheet = getSpreadsheet();
  
  // (ป้องกันการสร้าง User โดยไม่มี Hash)
  if (data.type === 'user' && !data.passwordHash) {
    throw new Error('Cannot create user without passwordHash. Use createUser action.');
  }
  
  saveToMainSheet(spreadsheet, 'CREATE', data);
  saveToSpecificSheet(spreadsheet, data);
  logActivity('CREATE', data.type, data.id, { user: user.username });
  
  // (ลบ Hash ก่อนส่งกลับ)
  if (data.type === 'user') {
    delete data.passwordHash;
  }
  return data;
}

function handleUpdate(data, user) {
  console.log(`✏️ ${user.username} updating:`, data.type, data.__backendId);
  const spreadsheet = getSpreadsheet();
  
  // (ป้องกันการอัปเดต User โดยไม่มี Hash)
  if (data.type === 'user' && data.password) {
     throw new Error('Cannot update user password directly. Use updateUser action.');
  }
  // (ลบ Hash ก่อนบันทึก ถ้ามันเผลอติดมา)
  if (data.type === 'user') {
    delete data.password; 
  }

  updateInMainSheet(spreadsheet, data);
  updateInSpecificSheet(spreadsheet, data);
  logActivity('UPDATE', data.type, data.__backendId, { user: user.username });
  
  // (ลบ Hash ก่อนส่งกลับ)
  if (data.type === 'user') {
    delete data.passwordHash;
  }
  return data;
}

function handleDelete(data, user) {
  console.log(`🗑️ ${user.username} deleting:`, data.id);
  const spreadsheet = getSpreadsheet();
  deleteFromSpecificSheets(spreadsheet, data.id); // ลบจากชีตเฉพาะก่อน
  deleteFromMainSheet(spreadsheet, data.id); // ค่อยลบจากชีตหลัก
  logActivity('DELETE', 'unknown', data.id, { user: user.username });
  return { id: data.id };
}

// ========== 7. ฟังก์ชัน Helper (ส่วนจัดการ Sheet) ==========

function getSpreadsheet() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID is not defined in Script Properties.');
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (error) {
    throw new Error(`Cannot open spreadsheet: ${error.message}`);
  }
}

function getOrCreateSheet(spreadsheet, sheetName) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    setupSheetHeaders(sheet, sheetName); // (โค้ด setupSheetHeaders ของคุณ)
  }
  return sheet;
}

// (เพิ่มฟังก์ชัน setupSheetHeaders(sheet, sheetName) ของคุณที่นี่)
// **สำคัญ:** แก้ไข Header ของ USERS ให้มี `passwordHash` และลบ `password`

function findRowByIdInSheet(sheet, id) {
  if (!id) return -1;
  const dataRange = sheet.getDataRange();
  if (dataRange.getNumRows() <= 1) return -1;
  const values = dataRange.getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === id) return i + 1; // 1-based index
  }
  return -1;
}

function saveToMainSheet(spreadsheet, action, data) {
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const now = new Date();
  const id = data.id || data.__backendId;
  
  // (แยก passwordHash ออกจาก JSON ที่เก็บ)
  let dataToStore = { ...data };
  let passwordHash = dataToStore.passwordHash;
  delete dataToStore.passwordHash;
  delete dataToStore.password;
  
  const jsonData = JSON.stringify(dataToStore);
  
  const existingRowIndex = findRowByIdInSheet(sheet, id);
  
  const rowData = [
    id,
    data.type,
    jsonData,
    data.createdAt ? new Date(data.createdAt) : now,
    now,
    'ACTIVE'
  ];
  
  if (existingRowIndex > 0) {
    sheet.getRange(existingRowIndex, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  
  // (อัปเดต Hash ในชีต Users แยกต่างหาก)
  if (data.type === 'user' && passwordHash) {
    const userSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.USERS);
    const userRowIndex = findRowByIdInSheet(userSheet, id);
    if (userRowIndex > 0) {
      // (สมมติว่า passwordHash อยู่คอลัมน์ F)
      userSheet.getRange(userRowIndex, 6).setValue(passwordHash); 
    }
  }
}

// (เพิ่มฟังก์ชัน saveToSpecificSheet(spreadsheet, data) ของคุณที่นี่)
// **สำคัญ:** แก้ไขชีต USERS ให้ *ไม่* บันทึก `data.password` แต่บันทึก `data.passwordHash` (ถ้าจำเป็น) หรือดีที่สุดคือให้ `saveToMainSheet` จัดการ

function updateInMainSheet(spreadsheet, data) {
   // (โค้ดเดิมของคุณ OK)
   // ... แต่ต้องแน่ใจว่ามันจัดการ passwordHash แยกเหมือน saveToMainSheet
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const targetId = data.__backendId || data.id;
  const rowIndex = findRowByIdInSheet(sheet, targetId);

  let dataToStore = { ...data };
  let passwordHash = dataToStore.passwordHash;
  delete dataToStore.passwordHash;
  delete dataToStore.password;
  
  const jsonData = JSON.stringify(dataToStore);
  
  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 3).setValue(jsonData); // Data column
    sheet.getRange(rowIndex, 5).setValue(new Date()); // Updated At column
  } else {
    saveToMainSheet(spreadsheet, 'UPDATE', data); // สร้างใหม่ถ้าไม่เจอ
  }
  
  if (data.type === 'user' && passwordHash) {
    const userSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.USERS);
    const userRowIndex = findRowByIdInSheet(userSheet, data.id);
    if (userRowIndex > 0) {
      // (สมมติว่า passwordHash อยู่คอลัมน์ F)
      userSheet.getRange(userRowIndex, 6).setValue(passwordHash);
    }
  }
}

// (เพิ่มฟังก์ชัน updateInSpecificSheet(spreadsheet, data) ของคุณที่นี่)

function deleteFromMainSheet(spreadsheet, id) {
  // (โค้ดเดิมของคุณ OK)
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const rowIndex = findRowByIdInSheet(sheet, id);
  if (rowIndex > 0) {
    sheet.deleteRow(rowIndex);
  }
}

function deleteFromSpecificSheets(spreadsheet, id) {
   // (โค้ดเดิมของคุณ OK)
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const mainRowIndex = findRowByIdInSheet(mainSheet, id);
  if (mainRowIndex <= 0) return;
  
  const type = mainSheet.getRange(mainRowIndex, 2).getValue();
  let sheetName;
  switch (type) {
    case 'chemical': sheetName = CONFIG.SHEET_NAMES.CHEMICALS; break;
    case 'equipment': sheetName = CONFIG.SHEET_NAMES.EQUIPMENT; break;
    case 'user': sheetName = CONFIG.SHEET_NAMES.USERS; break;
    case 'borrow': sheetName = CONFIG.SHEET_NAMES.BORROWS; break;
    case 'issue_report': sheetName = CONFIG.SHEET_NAMES.REPORTS; break;
  }
  
  if (sheetName) {
    const sheet = getOrCreateSheet(spreadsheet, sheetName);
    const rowIndex = findRowByIdInSheet(sheet, id);
    if (rowIndex > 0) {
      sheet.deleteRow(rowIndex);
    }
  }
}

function readAllFromMainSheet(mainSheet) {
  // (โค้ดเดิมของคุณ OK)
  const dataRange = mainSheet.getDataRange();
  const values = dataRange.getValues();
  const data = [];
  if (values.length <= 1) return [];
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[0];
    const status = row[5];
    
    if (status === 'ACTIVE' || !status) {
      try {
        const parsedData = JSON.parse(row[2]);
        parsedData.__backendId = id;
        
        // (ดึง passwordHash มาใส่ใน object เพื่อใช้ตอน Login)
        if (parsedData.type === 'user') {
          const userSheet = getOrCreateSheet(mainSheet.getParent(), CONFIG.SHEET_NAMES.USERS);
          const userRowIndex = findRowByIdInSheet(userSheet, id);
          if (userRowIndex > 0) {
            // (สมมติว่า passwordHash อยู่คอลัมน์ F)
            parsedData.passwordHash = userSheet.getRange(userRowIndex, 6).getValue();
          }
        }
        data.push(parsedData);
      } catch (error) {}
    }
  }
  return data;
}

function logActivity(action, type, id, details) {
   // (โค้ดเดิมของคุณ OK)
  try {
    const spreadsheet = getSpreadsheet();
    const logSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.LOGS);
    const user = (details && details.user) ? details.user : (Session.getActiveUser().getEmail() || 'unknown');
    logSheet.appendRow([ new Date(), action, type, id, user, JSON.stringify(details) ]);
  } catch (error) {}
}

function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// (เพิ่มฟังก์ชัน doGet ของคุณที่ใช้แสดง HTML)
function doGet(e) {
  // เมื่อผู้ใช้เปิด URL ของ Web App ตรงๆ
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
