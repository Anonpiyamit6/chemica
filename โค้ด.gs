const CONFIG = {
  SPREADSHEET_ID: '11AAHL2rHCTjtgcC2fteRGEeDy6Tz4vRHd4VimjobWec',
  SHEET_NAMES: {
    MAIN_DATA: 'ข้อมูลระบบ',
    CHEMICALS: 'สารเคมี',
    EQUIPMENT: 'อุปกรณ์',
    USERS: 'ผู้ใช้งาน',
    BORROWS: 'การยืม-คืน',
    LOGS: 'บันทึกการใช้งาน',
    REPORTS: 'รายงาน'
  }
};

// ========== ฟังก์ชันหลักสำหรับรับ HTTP Requests ==========

/**
 * จัดการ GET requests (รองรับ JSONP)
 */
function doGet(e) {
  // === ส่วนที่ 1: แสดงหน้าบ้าน (Frontend) ===
  // เมื่อผู้ใช้เปิด URL ของ Web App ตรงๆ (เช่น https://script.google.com/...)
  if (!e.parameter.action) {
    return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } 
  
  // === ส่วนที่ 2: ทำหน้าที่เป็น API (Backend) ===
  // เมื่อ JavaScript จากหน้าบ้าน (index.html) เรียกใช้
  else {
    try {
      const callback = e.parameter.callback;
      const action = e.parameter.action || 'status';
      const data = e.parameter.data ? JSON.parse(e.parameter.data) : {};
      
      console.log('📥 Received GET request:', { action, callback, dataSize: JSON.stringify(data).length });

      let result;
      switch (action) {
        case 'create':
          result = handleCreate(data);
          break;
        // ... (case อื่นๆ) ...
        default:
          result = { message: 'SmartLab Google Apps Script is running', timestamp: new Date().toISOString() };
      }

      const response = {
        status: 'success',
        data: result,
        timestamp: new Date().toISOString()
      };

      // ส่งกลับเป็น JSONP หากมี callback
      if (callback) {
        return ContentService
          .createTextOutput(`${callback}(${JSON.stringify(response)})`)
          .setMimeType(ContentService.MimeType.JAVSCRIPT);
      }

      // ส่งกลับเป็น JSON ปกติ
      return ContentService
        .createTextOutput(JSON.stringify(response))
        .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
      // ... (ส่วนจัดการ Error) ...
    }
  }
}



/**
 * จัดการ POST requests (สำรองสำหรับการใช้งานแบบ POST)
 */
function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      throw new Error('No data received');
    }

    const requestData = JSON.parse(e.postData.contents);
    console.log('📨 Received POST request:', requestData);

    const { action, data } = requestData;
    let result;

    switch (action) {
      case 'create':
        result = handleCreate(data);
        break;
      case 'update':
        result = handleUpdate(data);
        break;
      case 'delete':
        result = handleDelete(data);
        break;
      case 'sync':
        result = handleSync(data);
        break;
      case 'login':
        result = handleLogin(data);
        break;
      case 'report':
        result = generateReport(data);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'success',
        data: result,
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error('❌ Error in doPost:', error);
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'error',
        message: error.toString(),
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ========== ฟังก์ชันจัดการข้อมูล ==========

/**
 * สร้างข้อมูลใหม่
 */
function handleCreate(data) {
  console.log('➕ Creating new record:', data.type, data.id);
  
  const spreadsheet = getSpreadsheet();
  
  // บันทึกในชีตหลัก
  saveToMainSheet(spreadsheet, 'CREATE', data);
  
  // บันทึกในชีตเฉพาะตามประเภท
  saveToSpecificSheet(spreadsheet, data);
  
  // บันทึก log
  logActivity('CREATE', data.type, data.id, data);
  
  return { success: true, action: 'create', data: data }; 
}

function handleBorrowItem(borrowData, updatedItemData) {
  try {
    console.log('⚡ Handling borrow and stock update for:', borrowData.id, updatedItemData.__backendId);
    
    // 1. สร้างรายการยืม (เรียกใช้ Logic เดิม)
    const newBorrow = handleCreate(borrowData);
    if (!newBorrow.success) {
      throw new Error('Failed to create borrow record.');
    }

    // 2. อัปเดตสต็อก (เรียกใช้ Logic เดิม)
    const updatedItem = handleUpdate(updatedItemData);
    if (!updatedItem.success) {
      throw new Error('Failed to update item stock.');
    }
    
    // 3. ส่งข้อมูลทั้งสองกลับไปในครั้งเดียว
    return {
      success: true,
      action: 'borrow',
      borrow: newBorrow.data, // ข้อมูลการยืมใหม่
      item: updatedItem.data   // ข้อมูลสต็อกที่อัปเดตแล้ว
    };
    
  } catch (error) {
    console.error('❌ Error in handleBorrowItem:', error);
    return { success: false, message: error.toString() };
  }
}
/**
 * อัปเดตข้อมูล
 */
function handleUpdate(data) {
  console.log('✏️ Updating record:', data.type, data.__backendId || data.id);
  
  const spreadsheet = getSpreadsheet();
  
  // อัปเดตในชีตหลัก
  updateInMainSheet(spreadsheet, data);
  
  // อัปเดตในชีตเฉพาะ
  updateInSpecificSheet(spreadsheet, data);
  
  // บันทึก log
  logActivity('UPDATE', data.type, data.__backendId || data.id, data);
  
  return { success: true, action: 'update', data: data };
}

/**
 * ลบข้อมูล
 */
function handleDelete(data) {
  console.log('🗑️ HARD DELETING record:', data.id);
  
  const spreadsheet = getSpreadsheet();
  
  // [แก้ไข] ลบจากชีตเฉพาะก่อน (เพราะมันต้องอ่าน 'type' จากชีตหลัก)
  deleteFromSpecificSheets(spreadsheet, data.id);
  
  // [แก้ไข] ลบจากชีตหลักทีหลัง
  deleteFromMainSheet(spreadsheet, data.id);
  
  // บันทึก log
  logActivity('DELETE (HARD)', 'unknown', data.id, data);
  
  return {
    success: true,
    action: 'delete',
    id: data.id,
    timestamp: new Date().toISOString()
  };
}

/**
 * ซิงค์ข้อมูลทั้งหมด
 */
function handleSync(data) {
  console.log('🔄 Syncing data, received:', Array.isArray(data) ? data.length : 'single record');
  
  const spreadsheet = getSpreadsheet();
  
  if (Array.isArray(data) && data.length > 0) {
    // ซิงค์ข้อมูลทั้งหมดจาก Canva Code
    data.forEach(record => {
      try {
        saveToMainSheet(spreadsheet, 'SYNC', record);
        saveToSpecificSheet(spreadsheet, record);
      } catch (error) {
        console.error('Error syncing record:', record.id, error);
      }
    });
    
    logActivity('SYNC', 'bulk', 'multiple', { count: data.length });
    
    return {
      success: true,
      action: 'sync',
      synced: data.length,
      timestamp: new Date().toISOString()
    };
  } else {
    // ส่งข้อมูลทั้งหมดกลับไปยัง Canva Code
    const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
    const allData = readAllFromMainSheet(mainSheet);
    
    return {
      success: true,
      action: 'sync',
      data: allData,
      count: allData.length,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * จัดการการเข้าสู่ระบบ
 */
function handleLogin(data) {
  console.log('🔐 Login attempt:', data.username);
  
  // ตรวจสอบ admin account
  if (data.username === 'admin' && data.password === 'admin123') {
    logActivity('LOGIN', 'admin', 'admin', { success: true });
    return {
      success: true,
      user: {
        username: 'admin',
        role: 'admin',
        firstName: 'ผู้ดูแล',
        lastName: 'ระบบ'
      }
    };
  }
  
  // ตรวจสอบ user accounts จากฐานข้อมูล
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const allData = readAllFromMainSheet(mainSheet);
  
  const users = allData.filter(item => item.type === 'user');
  const user = users.find(u => u.username === data.username && u.password === data.password);
  
  if (user) {
    logActivity('LOGIN', 'user', user.username, { success: true });
    return {
      success: true,
      user: user
    };
  }
  
  logActivity('LOGIN', 'failed', data.username, { success: false });
  return {
    success: false,
    message: 'Invalid credentials'
  };
}

/**
 * สร้างรายงาน
 */
function generateReport(data) {
  console.log('📊 Generating report:', data.type);
  
  const spreadsheet = getSpreadsheet();
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const allData = readAllFromMainSheet(mainSheet);
  
  let reportData = [];
  
  switch (data.type) {
    case 'chemicals':
      reportData = allData.filter(item => item.type === 'chemical');
      break;
    case 'equipment':
      reportData = allData.filter(item => item.type === 'equipment');
      break;
    case 'borrows':
      reportData = allData.filter(item => item.type === 'borrow');
      break;
    case 'users':
      reportData = allData.filter(item => item.type === 'user');
      break;
    case 'low_stock':
      reportData = allData.filter(item => 
        (item.type === 'chemical' || item.type === 'equipment') && 
        item.quantity <= (item.minStock || 0)
      );
      break;
    default:
      reportData = allData;
  }
  
  // กรองตามวันที่ (สำหรับการยืม)
  if (data.startDate && data.type === 'borrows') {
    reportData = reportData.filter(item => 
      new Date(item.borrowDate) >= new Date(data.startDate)
    );
  }
  
  if (data.endDate && data.type === 'borrows') {
    reportData = reportData.filter(item => 
      new Date(item.borrowDate) <= new Date(data.endDate + 'T23:59:59')
    );
  }
  
  // กรองตามผู้ใช้
  if (data.user && data.type === 'borrows') {
    reportData = reportData.filter(item => item.borrower === data.user);
  }
  
  // บันทึกรายงานในชีต
  saveReportToSheet(spreadsheet, data.type, reportData);
  
  logActivity('REPORT', data.type, 'generated', { count: reportData.length });
  
  return {
    success: true,
    type: data.type,
    data: reportData,
    count: reportData.length,
    timestamp: new Date().toISOString()
  };
}

// ========== ฟังก์ชันจัดการ Spreadsheet ==========

/**
 * เปิด Spreadsheet
 */
function getSpreadsheet() {
  try {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (error) {
    throw new Error(`Cannot open spreadsheet: ${error.message}`);
  }
}

/**
 * สร้างหรือเปิดชีต
 */
function getOrCreateSheet(spreadsheet, sheetName) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  
  if (!sheet) {
    console.log(`📄 Creating new sheet: ${sheetName}`);
    sheet = spreadsheet.insertSheet(sheetName);
    setupSheetHeaders(sheet, sheetName);
  }
  
  return sheet;
}

/**
 * ตั้งค่า Headers สำหรับชีต
 */
function setupSheetHeaders(sheet, sheetName) {
  let headers = [];
  
  switch (sheetName) {
    case CONFIG.SHEET_NAMES.MAIN_DATA:
      headers = [
        'ID', 'Type', 'Data (JSON)', 'Created At', 'Updated At', 'Status'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.CHEMICALS:
      headers = [
        'ID', 'ชื่อสารเคมี', 'สูตรเคมี', 'จำนวน', 'หน่วย', 
        'สถานที่เก็บ', 'สต็อกขั้นต่ำ', 'สถานะ', 'วันที่สร้าง', 'วันที่อัปเดต'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.EQUIPMENT:
      headers = [
        'ID', 'ชื่ออุปกรณ์', 'จำนวน', 'หน่วย', 'สถานที่เก็บ', 
        'สต็อกขั้นต่ำ', 'สถานะ', 'จำนวนชำรุด', 'หมายเหตุ', 'วันที่สร้าง', 'วันที่อัปเดต'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.USERS:
      headers = [
        'ID', 'ชื่อผู้ใช้', 'ชื่อ', 'นามสกุล', 'บทบาท', 
        'วันที่สร้าง', 'วันที่อัปเดต', 'สถานะ'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.BORROWS:
      headers = [
        'ID', 'ผู้ยืม', 'รายการ', 'ประเภท', 'จำนวน', 'ห้อง', 
        'วันที่ยืม', 'วันที่คืน', 'สถานะ', 'หมายเหตุ'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.LOGS:
      headers = [
        'Timestamp', 'Action', 'Type', 'ID', 'User', 'Details'
      ];
      break;
      
    case CONFIG.SHEET_NAMES.REPORTS:
      headers = [
        'Report Type', 'Generated At', 'Data Count', 'Parameters', 'Status'
      ];
      break;
      
    default:
      headers = ['ID', 'Data', 'Timestamp'];
  }
  
  // ใส่ headers และจัดรูปแบบ
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setBackground('#667eea');
  headerRange.setFontColor('#ffffff');
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('center');
  
  // ปรับความกว้างคอลัมน์
  sheet.autoResizeColumns(1, headers.length);
  
  // ตรึงแถวแรก
  sheet.setFrozenRows(1);
}

// ========== ฟังก์ชันจัดการข้อมูลในชีต ==========

/**
 * บันทึกข้อมูลในชีตหลัก
 */
function saveToMainSheet(spreadsheet, action, data) {
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const now = new Date();
  
  // ตรวจสอบว่ามีข้อมูลอยู่แล้วหรือไม่
  const existingRowIndex = findRowByIdInSheet(sheet, data.id || data.__backendId);
  
  const rowData = [
    data.id || data.__backendId,
    data.type,
    JSON.stringify(data),
    data.createdAt ? new Date(data.createdAt) : now,
    now,
    'ACTIVE'
  ];
  
  if (existingRowIndex > 0) {
    // อัปเดตข้อมูลที่มีอยู่
    const range = sheet.getRange(existingRowIndex, 1, 1, rowData.length);
    range.setValues([rowData]);
    console.log(`📝 Updated existing record in main sheet: ${data.id || data.__backendId}`);
  } else {
    // เพิ่มข้อมูลใหม่
    sheet.appendRow(rowData);
    console.log(`➕ Added new record to main sheet: ${data.id || data.__backendId}`);
  }
}

/**
 * บันทึกข้อมูลในชีตเฉพาะตามประเภท
 */
function saveToSpecificSheet(spreadsheet, data) {
  let sheetName;
  let rowData = [];
  const now = new Date();
  
  switch (data.type) {
    case 'chemical':
      sheetName = CONFIG.SHEET_NAMES.CHEMICALS;
      rowData = [
        data.id,
        data.name,
        data.formula || '',
        data.quantity,
        data.unit,
        data.location,
        data.minStock || 0,
        data.quantity <= (data.minStock || 0) ? 'สต็อกต่ำ' : 'ปกติ',
        data.createdAt ? new Date(data.createdAt) : now,
        now
      ];
      break;
      
    case 'equipment':
      sheetName = CONFIG.SHEET_NAMES.EQUIPMENT;
      rowData = [
        data.id,
        data.name,
        data.quantity,
        data.unit,
        data.location,
        data.minStock || 0,
        data.status || 'ปกติ',
        data.damagedQuantity || 0,
        data.damageNote || '',
        data.createdAt ? new Date(data.createdAt) : now,
        now
      ];
      break;
      
    case 'user':
      sheetName = CONFIG.SHEET_NAMES.USERS;
      rowData = [
        data.id,
        data.username,
        data.firstName || '',
        data.lastName || '',
        data.role === 'admin' ? 'ผู้ดูแลระบบ' : 'ครู',
        data.createdAt ? new Date(data.createdAt) : now,
        now,
        'ใช้งานได้'
      ];
      break;
      
    case 'borrow':
      sheetName = CONFIG.SHEET_NAMES.BORROWS;
      rowData = [
        data.id,
        data.borrower,
        data.itemName,
        data.itemType === 'chemical' ? 'สารเคมี' : 'อุปกรณ์',
        data.amount,
        data.room,
        new Date(data.borrowDate),
        data.returnDate ? new Date(data.returnDate) : '',
        data.status === 'returned' ? 'คืนแล้ว' : 'ยังไม่คืน',
        data.returnNote || ''
      ];
      break;
  }
  
  if (sheetName && rowData.length > 0) {
    const sheet = getOrCreateSheet(spreadsheet, sheetName);
    const existingRowIndex = findRowByIdInSheet(sheet, data.id);
    
    if (existingRowIndex > 0) {
      // อัปเดตข้อมูลที่มีอยู่
      const range = sheet.getRange(existingRowIndex, 1, 1, rowData.length);
      range.setValues([rowData]);
    } else {
      // เพิ่มข้อมูลใหม่
      sheet.appendRow(rowData);
    }
  }
}

/**
 * บันทึกรายงานในชีต
 */
function saveReportToSheet(spreadsheet, reportType, reportData) {
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.REPORTS);
  
  const reportRow = [
    reportType,
    new Date(),
    reportData.length,
    JSON.stringify({ type: reportType, filters: 'various' }),
    'Generated'
  ];
  
  sheet.appendRow(reportRow);
}

/**
 * หาแถวตาม ID ในชีต
 */
function findRowByIdInSheet(sheet, id) {
  if (!id) return -1;
  
  const dataRange = sheet.getDataRange();
  if (dataRange.getNumRows() <= 1) return -1;
  
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === id) {
      return i + 1; // +1 เพราะ getRange ใช้ 1-based index
    }
  }
  
  return -1;
}

/**
 * อัปเดตข้อมูลในชีตหลัก
 */
function updateInMainSheet(spreadsheet, data) {
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const targetId = data.__backendId || data.id;
  const rowIndex = findRowByIdInSheet(sheet, targetId);
  
  if (rowIndex > 0) {
    // อัปเดตข้อมูล
    sheet.getRange(rowIndex, 3).setValue(JSON.stringify(data)); // Data column
    sheet.getRange(rowIndex, 5).setValue(new Date()); // Updated At column
    console.log(`✅ Updated record in main sheet: ${targetId}`);
  } else {
    console.log(`⚠️ Record not found in main sheet: ${targetId}`);
    // หากไม่พบ ให้สร้างใหม่
    saveToMainSheet(spreadsheet, 'UPDATE', data);
  }
}

/**
 * อัปเดตข้อมูลในชีตเฉพาะ
 */
function updateInSpecificSheet(spreadsheet, data) {
  let sheetName;
  
  switch (data.type) {
    case 'chemical':
      sheetName = CONFIG.SHEET_NAMES.CHEMICALS;
      break;
    case 'equipment':
      sheetName = CONFIG.SHEET_NAMES.EQUIPMENT;
      break;
    case 'user':
      sheetName = CONFIG.SHEET_NAMES.USERS;
      break;
      case 'borrow':
      sheetName = CONFIG.SHEET_NAMES.BORROWS;
      break;
    default:
      console.log(`No specific sheet to update for type: ${data.type}`);
      return; // ออกจากฟังก์ชันหากไม่มีชีตเฉพาะ
  }
  
  if (sheetName) {
    // เราสามารถเรียกใช้ saveToSpecificSheet ได้เลย
    // เพราะฟังก์ชันนั้นมีการตรวจสอบ (findRowByIdInSheet) และอัปเดตแถวที่มีอยู่แล้ว
    saveToSpecificSheet(spreadsheet, data);
    console.log(`✅ Updated record in specific sheet: ${sheetName} -> ${data.id || data.__backendId}`);
  }
}

/**
 * ลบข้อมูลออกจากชีตหลัก (Soft Delete)
 */
function deleteFromMainSheet(spreadsheet, id) {
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const rowIndex = findRowByIdInSheet(sheet, id);
  
  if (rowIndex > 0) {
    // [แก้ไข] เปลี่ยนจาก Soft Delete เป็น Hard Delete
    sheet.deleteRow(rowIndex);
    console.log(`🗑️ HARD DELETED record from main sheet: ${id} (row ${rowIndex})`);
  } else {
    console.log(`⚠️ Record not found in main sheet for deletion: ${id}`);
  }
}

/**
 * ลบข้อมูลออกจากชีตเฉพาะ (Soft Delete)
 */
function deleteFromSpecificSheets(spreadsheet, id) {
  // ค้นหาประเภทของข้อมูลจากชีตหลักก่อน
  const mainSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.MAIN_DATA);
  const mainRowIndex = findRowByIdInSheet(mainSheet, id);
  
  if (mainRowIndex <= 0) {
    console.log(`Cannot find record ${id} in main sheet to determine type for deletion.`);
    return;
  }
  
  const type = mainSheet.getRange(mainRowIndex, 2).getValue();
  let sheetName;
  
  // [แก้ไข] เราไม่ต้องการ statusColumnIndex แล้ว
  switch (type) {
    case 'chemical':
      sheetName = CONFIG.SHEET_NAMES.CHEMICALS;
      break;
    case 'equipment':
      sheetName = CONFIG.SHEET_NAMES.EQUIPMENT;
      break;
    case 'user':
      sheetName = CONFIG.SHEET_NAMES.USERS;
      break;
    case 'borrow':
      sheetName = CONFIG.SHEET_NAMES.BORROWS;
      break;
  }
  
  if (sheetName) {
    const sheet = getOrCreateSheet(spreadsheet, sheetName);
    const rowIndex = findRowByIdInSheet(sheet, id); // หาแถวในชีตเฉพาะ
    
    if (rowIndex > 0) {
      // [แก้ไข] เปลี่ยนจาก Soft Delete เป็น Hard Delete
      sheet.deleteRow(rowIndex);
      console.log(`🗑️ HARD DELETED record from specific sheet: ${sheetName} -> ${id} (row ${rowIndex})`);
    }
  }
}

/**
 * บันทึก Log การทำงาน
 */
function logActivity(action, type, id, details) {
  try {
    const spreadsheet = getSpreadsheet();
    const logSheet = getOrCreateSheet(spreadsheet, CONFIG.SHEET_NAMES.LOGS);
    
    const timestamp = new Date();
    // พยายามดึงอีเมลผู้ใช้ที่กำลังทำงาน (อาจเป็น 'unknown' หากรันแบบ anonymous)
    const user = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'unknown';
    const detailsString = typeof details === 'object' ? JSON.stringify(details) : String(details);
    
    logSheet.appendRow([
      timestamp,
      action,
      type,
      id,
      user,
      detailsString
    ]);
  } catch (error) {
    console.error('❌ Failed to write log:', error);
    // ไม่ throw error เพื่อให้การทำงานหลักดำเนินต่อไปได้
  }
}

/**
 * อ่านข้อมูลทั้งหมดจากชีตหลัก (สำหรับ Sync)
 */
function readAllFromMainSheet(mainSheet) {
  const dataRange = mainSheet.getDataRange();
  const values = dataRange.getValues();
  const data = [];
  
  if (values.length <= 1) {
    return []; // ไม่มีข้อมูล (มีแต่ header)
  }
  
  // เริ่มจาก i = 1 เพื่อข้ามแถว header
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[0];
    const type = row[1];
    const jsonString = row[2];
    const status = row[5]; // คอลัมน์ 'Status'
    
    // ดึงเฉพาะข้อมูลที่ยังมีสถานะ 'ACTIVE'
    if (status === 'ACTIVE' || !status) { // (เผื่อข้อมูลเก่าที่ยังไม่มี status)
      try {
        const parsedData = JSON.parse(jsonString);
        parsedData.__backendId = id; // ตรวจสอบให้แน่ใจว่า ID จากชีตถูกส่งกลับไป
        data.push(parsedData);
      } catch (error) {
        console.error(`Failed to parse JSON for ID ${id}:`, error, jsonString);
      }
    }
  }
  
  return data;
}

/**
 * ตรวจสอบสถานะระบบ (สำหรับ action=status)
 */
function getSystemStatus() {
  console.log('🩺 Checking system status...');
  let status = {
    service: 'SmartLab Backend',
    status: 'Operational',
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    timestamp: new Date().toISOString()
  };
  
  try {
    // ทดสอบการเชื่อมต่อกับ Spreadsheet
    const spreadsheet = getSpreadsheet();
    status.spreadsheetName = spreadsheet.getName();
    status.connection = 'Success';
  } catch (error) {
    status.status = 'Error';
    status.connection = 'Failed';
    status.error = error.message;
  }
  return status;
}


/**
 * ฟังก์ชันทดสอบการเชื่อมต่อ (สำหรับ action=test)
 */
function testConnection() {
  console.log('🧪 Running test connection...');
  try {
    const spreadsheet = getSpreadsheet();
    return {
      success: true,
      message: 'Connection successful',
      spreadsheetName: spreadsheet.getName(),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      message: 'Connection failed',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}
