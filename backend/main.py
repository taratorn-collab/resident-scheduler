from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List
import datetime
import holidays

from database import engine, get_db, Base
from models import (
    DBBlock, DBResidentBlockInfo, DBShiftAssignment,
    GenerateRequest, GenerateResponse, ValidateRequest, ValidateResponse,
    ShiftTypeConfig, ResidentInput, ShiftAssignmentOutput, ResidentStats, ConstraintViolation,
    DBResidentEmailMapping, DBResidentBlockedDate, AuthRequest, ProfileMappingRequest, BlockedDateRequest,
    BlockedDatesSyncRequest
)
from solver import solve_schedule, validate_schedule
from auth import verify_google_token
from calendar_feed import generate_ical_feed
import uuid
import os
from fastapi import Header, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Create DB Tables on Startup
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Resident Shift Allocation API")

# Enable CORS for React frontend (Vite defaults to localhost:5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For local ease, restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# Core Algorithm Endpoints
# ==========================================

@app.post("/api/generate", response_model=GenerateResponse)
def api_generate_schedule(req: GenerateRequest, db: Session = Depends(get_db)):
    try:
        # Merge resident-requested blocked dates from DB
        for res in req.residents:
            db_blocked = db.query(DBResidentBlockedDate).filter(
                DBResidentBlockedDate.resident_name == res.name
            ).all()
            db_blocked_dates = [b.blocked_date.isoformat() for b in db_blocked]
            res.blocked_dates = list(set(res.blocked_dates + db_blocked_dates))
            
        response = solve_schedule(req)
        return response
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Scheduling solver error: {str(e)}"
        )

@app.post("/api/validate", response_model=ValidateResponse)
def api_validate_schedule(req: ValidateRequest, db: Session = Depends(get_db)):
    try:
        # Merge resident-requested blocked dates from DB
        for res in req.residents:
            db_blocked = db.query(DBResidentBlockedDate).filter(
                DBResidentBlockedDate.resident_name == res.name
            ).all()
            db_blocked_dates = [b.blocked_date.isoformat() for b in db_blocked]
            res.blocked_dates = list(set(res.blocked_dates + db_blocked_dates))
            
        response = validate_schedule(req)
        return response
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Validation logic error: {str(e)}"
        )

@app.get("/api/holidays")
def api_get_holidays(start_date: str, end_date: str):
    try:
        start_dt = datetime.date.fromisoformat(start_date)
        end_dt = datetime.date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    
    years = list(range(start_dt.year, end_dt.year + 1))
    th_holidays = holidays.Thailand(years=years)
    
    results = []
    for h_date, h_name in sorted(th_holidays.items()):
        if start_dt <= h_date <= end_dt:
            results.append({
                "date": h_date.isoformat(),
                "name": h_name
            })
    return results

@app.get("/api/rotations")
def api_get_rotations(block_name: str):
    import csv
    import os
    import re

    try:
        csv_path = os.path.join(os.path.dirname(__file__), "rotations.csv")
        if not os.path.exists(csv_path):
            raise HTTPException(status_code=404, detail="rotations.csv not found.")
        
        with open(csv_path, mode="r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames
            if not headers:
                return {}

            matched_header = None
            block_lower = block_name.lower()
            
            # Strategy 1: Check if the CSV header name is a substring of the block_name
            for h in headers:
                if h.lower() != "resident" and h.lower() in block_lower:
                    matched_header = h
                    break
                    
            # Strategy 2: Check if clean block name matches a CSV header
            if not matched_header:
                block_clean = block_name.split(":")[0].strip().lower()
                for h in headers:
                    h_clean = h.strip().lower()
                    if h_clean == block_clean or h_clean in block_clean or block_clean in h_clean:
                        matched_header = h
                        break
                        
            # Strategy 3: Parse the block number and pick that column (1-indexed)
            if not matched_header:
                nums = re.findall(r'\d+', block_name.split(":")[0])
                if nums:
                    block_num = int(nums[0])
                    if 1 <= block_num < len(headers):
                        matched_header = headers[block_num]

            if not matched_header:
                for h in headers:
                    if h.strip().lower() == block_name.strip().lower():
                        matched_header = h
                        break
                        
            if not matched_header:
                raise HTTPException(
                    status_code=404, 
                    detail=f"No matching column found in the rotation spreadsheet for block '{block_name}'."
                )
                
            rotations = {}
            for row in reader:
                resident = row.get("Resident", "").strip()
                rot_val = row.get(matched_header, "").strip()
                if resident and rot_val:
                    rotations[resident] = rot_val
                    
            return rotations
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read rotations: {str(e)}")

@app.get("/api/opd")
def api_get_opd(block_name: str):
    import csv
    import os
    import re

    def is_block_match(csv_block: str, request_block: str) -> bool:
        csv_block_lower = csv_block.strip().lower()
        request_block_lower = request_block.strip().lower()
        
        # Strategy 1: Substring match
        if csv_block_lower in request_block_lower or request_block_lower in csv_block_lower:
            return True
            
        # Strategy 2: Clean name comparison (split by colon and strip)
        csv_clean = csv_block_lower.split(":")[0].strip()
        req_clean = request_block_lower.split(":")[0].strip()
        if csv_clean == req_clean or csv_clean in req_clean or req_clean in csv_clean:
            return True
            
        # Strategy 3: Compare block number
        csv_nums = re.findall(r'\d+', csv_clean)
        req_nums = re.findall(r'\d+', req_clean)
        if csv_nums and req_nums and csv_nums[0] == req_nums[0]:
            return True
            
        return False

    try:
        csv_path = os.path.join(os.path.dirname(__file__), "opd.csv")
        if not os.path.exists(csv_path):
            raise HTTPException(status_code=404, detail="opd.csv not found.")
        
        # First, read rotations.csv to get the comprehensive list of all resident names.
        # This guarantees we initialize every resident with an empty list.
        residents_list = []
        rot_path = os.path.join(os.path.dirname(__file__), "rotations.csv")
        if os.path.exists(rot_path):
            with open(rot_path, mode="r", encoding="utf-8-sig") as f_rot:
                rot_reader = csv.DictReader(f_rot)
                for r_row in rot_reader:
                    r_name = r_row.get("Resident", "").strip()
                    if r_name:
                        residents_list.append(r_name)
        
        # Fallback to the 18 default names if rotations.csv is missing or empty
        if not residents_list:
            residents_list = [
                "จิรภัตรา", "ชนกนันท์", "ณัฐพล", "ตะวัน", "ธนวันต์", "ธรรศ",
                "ธราธร", "ธีรดนย์", "นราวิชญ์", "ประภากร", "ภูริภัค", "ยลรดา",
                "รุ่งไพลิน", "วัชรพล", "สิรภพ", "อภิชาต", "อภิสรา", "อริศรา"
            ]
            
        opds = {r: [] for r in residents_list}
        
        with open(csv_path, mode="r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames
            if not headers or "Resident" not in headers or "Block" not in headers or "OPD_Days" not in headers:
                raise HTTPException(status_code=500, detail="opd.csv is missing required headers: Resident, Block, OPD_Days")
                
            for row in reader:
                resident = row.get("Resident", "").strip()
                block = row.get("Block", "").strip()
                opd_val = row.get("OPD_Days", "").strip()
                
                if resident in opds and is_block_match(block, block_name):
                    if opd_val:
                        # Split by comma if there are multiple days
                        opds[resident] = [day.strip() for day in opd_val.split(",") if day.strip()]
                    else:
                        opds[resident] = []
                        
            return opds
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read OPD days: {str(e)}")




# ==========================================
# Database CRUD Endpoints
# ==========================================

@app.get("/api/blocks")
def get_all_blocks(db: Session = Depends(get_db)):
    blocks = db.query(DBBlock).order_by(DBBlock.start_date.desc()).all()
    return [
        {
            "id": b.id,
            "name": b.name,
            "start_date": b.start_date.isoformat(),
            "end_date": b.end_date.isoformat()
        }
        for b in blocks
    ]

@app.get("/api/blocks/{block_id}")
def get_block_details(block_id: int, db: Session = Depends(get_db)):
    block = db.query(DBBlock).filter(DBBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    
    # Get residents
    residents_db = db.query(DBResidentBlockInfo).filter(DBResidentBlockInfo.block_id == block_id).all()
    residents = []
    for r in residents_db:
        opd = r.opd_days.split(",") if r.opd_days else []
        blocked = r.blocked_dates.split(",") if r.blocked_dates else []
        residents.append({
            "name": r.resident_name,
            "rotation": r.rotation,
            "opd_days": opd,
            "blocked_dates": blocked
        })
        
    # Get assignments
    assigns_db = db.query(DBShiftAssignment).filter(DBShiftAssignment.block_id == block_id).all()
    assignments = []
    for a in assigns_db:
        d_str = a.date.isoformat()
        d_val = a.date
        # Determine if weekend (5=Saturday, 6=Sunday)
        is_wk = d_val.weekday() in (5, 6)
        assignments.append({
            "date": d_str,
            "day_name": d_val.strftime("%A"),
            "shift_type": a.shift_type,
            "resident_name": a.resident_name,
            "is_locked": a.is_locked,
            "is_weekend": is_wk,
            "hours": 24 if is_wk else 16
        })
        
    return {
        "id": block.id,
        "name": block.name,
        "start_date": block.start_date.isoformat(),
        "end_date": block.end_date.isoformat(),
        "residents": residents,
        "assignments": assignments
    }

@app.post("/api/blocks/save")
def save_block_details(payload: dict, db: Session = Depends(get_db)):
    """
    Saves a block, including the resident inputs and assignment details.
    Allows saving manually adjusted shift schedules.
    """
    block_name = payload.get("block_name")
    start_date_str = payload.get("start_date")
    end_date_str = payload.get("end_date")
    residents = payload.get("residents", [])
    assignments = payload.get("assignments", [])
    
    if not block_name or not start_date_str or not end_date_str:
        raise HTTPException(status_code=400, detail="Missing required block parameters")
        
    start_dt = datetime.date.fromisoformat(start_date_str)
    end_dt = datetime.date.fromisoformat(end_date_str)
    
    # Check if block with this name already exists, if so overwrite/delete old data
    existing_block = db.query(DBBlock).filter(DBBlock.name == block_name).first()
    if existing_block:
        db.delete(existing_block)
        db.commit()
        
    # Create new block
    db_block = DBBlock(name=block_name, start_date=start_dt, end_date=end_dt)
    db.add(db_block)
    db.commit()
    db.refresh(db_block)
    
    # Save resident block info
    for r in residents:
        opd_str = ",".join(r.get("opd_days", []))
        blocked_str = ",".join(r.get("blocked_dates", []))
        
        db_res = DBResidentBlockInfo(
            block_id=db_block.id,
            resident_name=r.get("name"),
            rotation=r.get("rotation"),
            opd_days=opd_str,
            blocked_dates=blocked_str
        )
        db.add(db_res)
        
    # Save assignments
    for a in assignments:
        a_date = datetime.date.fromisoformat(a.get("date"))
        db_assign = DBShiftAssignment(
            block_id=db_block.id,
            date=a_date,
            shift_type=a.get("shift_type"),
            resident_name=a.get("resident_name"),
            is_locked=a.get("is_locked", False)
        )
        db.add(db_assign)
        
    db.commit()
    return {"status": "SUCCESS", "block_id": db_block.id, "message": f"Block '{block_name}' saved successfully."}

@app.delete("/api/blocks/{block_id}")
def delete_block(block_id: int, db: Session = Depends(get_db)):
    block = db.query(DBBlock).filter(DBBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    db.delete(block)
    db.commit()
    return {"status": "SUCCESS", "message": f"Block {block_id} deleted successfully."}

# ==========================================
# Authentication & Resident Portal Endpoints
# ==========================================

def get_email_from_auth(authorization: str = Header(...)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization.split(" ")[1]
    user_info = verify_google_token(token)
    return user_info.get("email")

@app.post("/api/auth/google")
def api_google_auth(req: AuthRequest, db: Session = Depends(get_db)):
    user_info = verify_google_token(req.id_token)
    email = user_info.get("email")
    
    # Check if mapping exists
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    
    # Check if admin mapping exists
    admin_setting = db.query(DBResidentEmailMapping).filter(
        DBResidentEmailMapping.email == email,
        DBResidentEmailMapping.resident_name == "ADMIN"
    ).first()
    is_admin = (admin_setting is not None) or (email == "admin@example.com") or (email.split("@")[0] == "tuinui")
    
    return {
        "status": "SUCCESS",
        "user": {
            "email": email,
            "name": user_info.get("name"),
            "picture": user_info.get("picture"),
            "is_admin": is_admin,
            "resident_name": mapping.resident_name if mapping else None,
            "ical_token": mapping.ical_token if mapping else None
        }
    }

@app.post("/api/resident/map")
def api_map_profile(req: ProfileMappingRequest, authorization: str = Header(...), db: Session = Depends(get_db)):
    email = get_email_from_auth(authorization)
    
    # Clear existing mapping for mock account to make repeated testing easy
    if email == "resident@example.com":
        db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).delete()
        db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.resident_name == req.resident_name).delete()
        db.commit()
    
    existing_mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    if existing_mapping:
        raise HTTPException(status_code=400, detail="This email is already linked to a resident.")
        
    name_taken = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.resident_name == req.resident_name).first()
    if name_taken:
        raise HTTPException(status_code=400, detail="This resident name is already linked to another email.")
        
    ical_token = str(uuid.uuid4())
    new_mapping = DBResidentEmailMapping(
        email=email,
        resident_name=req.resident_name,
        ical_token=ical_token
    )
    db.add(new_mapping)
    db.commit()
    
    return {
        "status": "SUCCESS",
        "resident_name": req.resident_name,
        "ical_token": ical_token
    }

@app.get("/api/resident/profile")
def api_get_resident_profile(authorization: str = Header(...), db: Session = Depends(get_db)):
    email = get_email_from_auth(authorization)
    
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    if not mapping:
        return {"status": "UNMAPPED", "email": email}
        
    res_name = mapping.resident_name
    
    recent_info = db.query(DBResidentBlockInfo).filter(
        DBResidentBlockInfo.resident_name == res_name
    ).order_by(DBResidentBlockInfo.id.desc()).first()
    
    rotation = "Not set"
    opd_days = []
    
    if recent_info:
        rotation = recent_info.rotation
        opd_days = recent_info.opd_days.split(",") if recent_info.opd_days else []
    else:
        # Fallback: Query CSV files for active block if no DB record exists yet
        latest_block = db.query(DBBlock).order_by(DBBlock.id.desc()).first()
        block_name = latest_block.name if latest_block else "Block 1: 1 ก.ค. - 1 ส.ค. 69"
        
        try:
            rot_data = api_get_rotations(block_name)
            if res_name in rot_data:
                rotation = rot_data[res_name]
        except Exception:
            pass
            
        try:
            opd_data = api_get_opd(block_name)
            if res_name in opd_data:
                opd_days = opd_data[res_name]
        except Exception:
            pass
    
    db_blocked = db.query(DBResidentBlockedDate).filter(
        DBResidentBlockedDate.resident_name == res_name
    ).all()
    blocked_dates = [b.blocked_date.isoformat() for b in db_blocked]
    
    db_assigns = db.query(DBShiftAssignment).filter(
        DBShiftAssignment.resident_name == res_name
    ).order_by(DBShiftAssignment.date.asc()).all()
    
    assignments = []
    for a in db_assigns:
        assignments.append({
            "date": a.date.isoformat(),
            "day_name": a.date.strftime("%A"),
            "shift_type": a.shift_type,
            "is_locked": a.is_locked
        })
        
    return {
        "status": "SUCCESS",
        "resident_name": res_name,
        "rotation": rotation,
        "opd_days": opd_days,
        "blocked_dates": blocked_dates,
        "ical_token": mapping.ical_token,
        "assignments": assignments
    }

@app.post("/api/resident/blocked_dates")
def api_add_blocked_date(req: BlockedDateRequest, authorization: str = Header(...), db: Session = Depends(get_db)):
    # Lock editing on or after the 20th of every month (Disabled temporarily for testing)
    # if datetime.date.today().day >= 20:
    #     raise HTTPException(
    #         status_code=403, 
    #         detail="ระบบปิดรับการแก้ไขวันลาสำหรับรอบนี้แล้ว (ตั้งแต่วันที่ 20 ของเดือน)"
    #     )
        
    email = get_email_from_auth(authorization)
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    if not mapping:
        raise HTTPException(status_code=400, detail="Profile not mapped")
        
    res_name = mapping.resident_name
    try:
        blocked_dt = datetime.date.fromisoformat(req.date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
    existing = db.query(DBResidentBlockedDate).filter(
        DBResidentBlockedDate.resident_name == res_name,
        DBResidentBlockedDate.blocked_date == blocked_dt
    ).first()
    
    if not existing:
        new_blocked = DBResidentBlockedDate(resident_name=res_name, blocked_date=blocked_dt)
        db.add(new_blocked)
        db.commit()
        
    return {"status": "SUCCESS"}

@app.delete("/api/resident/blocked_dates/{date_str}")
def api_delete_blocked_date(date_str: str, authorization: str = Header(...), db: Session = Depends(get_db)):
    # Lock editing on or after the 20th of every month (Disabled temporarily for testing)
    # if datetime.date.today().day >= 20:
    #     raise HTTPException(
    #         status_code=403, 
    #         detail="ระบบปิดรับการแก้ไขวันลาสำหรับรอบนี้แล้ว (ตั้งแต่วันที่ 20 ของเดือน)"
    #     )
        
    email = get_email_from_auth(authorization)
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    if not mapping:
        raise HTTPException(status_code=400, detail="Profile not mapped")
        
    res_name = mapping.resident_name
    try:
        blocked_dt = datetime.date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
    db.query(DBResidentBlockedDate).filter(
        DBResidentBlockedDate.resident_name == res_name,
        DBResidentBlockedDate.blocked_date == blocked_dt
    ).delete()
    db.commit()
    
    return {"status": "SUCCESS"}

@app.post("/api/resident/blocked_dates/sync")
def api_sync_blocked_dates(req: BlockedDatesSyncRequest, authorization: str = Header(...), db: Session = Depends(get_db)):
    # Lock editing on or after the 20th of every month (Disabled temporarily for testing)
    # if datetime.date.today().day >= 20:
    #     raise HTTPException(
    #         status_code=403, 
    #         detail="ระบบปิดรับการแก้ไขวันลาสำหรับรอบนี้แล้ว (ตั้งแต่วันที่ 20 ของเดือน)"
    #     )
        
    email = get_email_from_auth(authorization)
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.email == email).first()
    if not mapping:
        raise HTTPException(status_code=400, detail="Profile not mapped")
        
    res_name = mapping.resident_name
    
    # Parse dates
    parsed_dates = []
    for d_str in req.dates:
        try:
            parsed_dates.append(datetime.date.fromisoformat(d_str))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: {d_str}. Use YYYY-MM-DD.")
            
    # Clear existing
    db.query(DBResidentBlockedDate).filter(DBResidentBlockedDate.resident_name == res_name).delete()
    
    # Insert new
    for d in parsed_dates:
        new_blocked = DBResidentBlockedDate(resident_name=res_name, blocked_date=d)
        db.add(new_blocked)
        
    db.commit()
    return {"status": "SUCCESS"}

@app.get("/api/admin/mappings")
def api_get_mappings(authorization: str = Header(...), db: Session = Depends(get_db)):
    email = get_email_from_auth(authorization)
    admin_setting = db.query(DBResidentEmailMapping).filter(
        DBResidentEmailMapping.email == email,
        DBResidentEmailMapping.resident_name == "ADMIN"
    ).first()
    is_admin = (admin_setting is not None) or (email == "admin@example.com") or (email.split("@")[0] == "tuinui")
    if not is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    mappings = db.query(DBResidentEmailMapping).all()
    return [
        {
            "email": m.email,
            "resident_name": m.resident_name,
            "ical_token": m.ical_token
        }
        for m in mappings
    ]

@app.post("/api/admin/unmap/{resident_name}")
def api_unmap_resident(resident_name: str, authorization: str = Header(...), db: Session = Depends(get_db)):
    email = get_email_from_auth(authorization)
    admin_setting = db.query(DBResidentEmailMapping).filter(
        DBResidentEmailMapping.email == email,
        DBResidentEmailMapping.resident_name == "ADMIN"
    ).first()
    is_admin = (admin_setting is not None) or (email == "admin@example.com") or (email.split("@")[0] == "tuinui")
    if not is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.resident_name == resident_name).delete()
    db.commit()
    return {"status": "SUCCESS"}

@app.get("/api/admin/blocked_dates")
def api_admin_get_blocked_dates(authorization: str = Header(...), db: Session = Depends(get_db)):
    email = get_email_from_auth(authorization)
    admin_setting = db.query(DBResidentEmailMapping).filter(
        DBResidentEmailMapping.email == email,
        DBResidentEmailMapping.resident_name == "ADMIN"
    ).first()
    is_admin = (admin_setting is not None) or (email == "admin@example.com") or (email.split("@")[0] == "tuinui")
    if not is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")
        
    all_blocked = db.query(DBResidentBlockedDate).all()
    out = {}
    for b in all_blocked:
        out.setdefault(b.resident_name, []).append(b.blocked_date.isoformat())
    return out

@app.get("/api/stats/comparison")
def api_get_stats_comparison(db: Session = Depends(get_db)):
    try:
        # 1. Fetch all blocks
        blocks = db.query(DBBlock).order_by(DBBlock.start_date.asc()).all()
        
        # 2. Find all unique resident names
        residents_list = []
        import os, csv
        rot_path = os.path.join(os.path.dirname(__file__), "rotations.csv")
        if os.path.exists(rot_path):
            try:
                with open(rot_path, mode="r", encoding="utf-8-sig") as f_rot:
                    rot_reader = csv.DictReader(f_rot)
                    for r_row in rot_reader:
                        r_name = r_row.get("Resident", "").strip()
                        if r_name:
                            residents_list.append(r_name)
            except Exception:
                pass
        
        if not residents_list:
            residents_list = [
                "จิรภัตรา", "ชนกนันท์", "ณัฐพล", "ตะวัน", "ธนวันต์", "ธรรศ",
                "ธราธร", "ธีรดนย์", "นราวิชญ์", "ประภากร", "ภูริภัค", "ยลรดา",
                "รุ่งไพลิน", "วัชรพล", "สิรภพ", "อภิชาต", "อภิสรา", "อริศรา"
            ]
            
        db_res_names = [r[0] for r in db.query(DBResidentBlockInfo.resident_name).distinct().all() if r[0]]
        db_assign_names = [r[0] for r in db.query(DBShiftAssignment.resident_name).distinct().all() if r[0]]
        
        all_residents_set = set(residents_list)
        all_residents_set.update(db_res_names)
        all_residents_set.update(db_assign_names)
        if "ADMIN" in all_residents_set:
            all_residents_set.remove("ADMIN")
            
        sorted_residents = sorted(list(all_residents_set))
        
        # 3. Find all unique shift types
        shift_types_set = {"MICU", "CCU", "ต่างแผนก", "แยกโรค"}
        db_shift_types = [s[0] for s in db.query(DBShiftAssignment.shift_type).distinct().all() if s[0]]
        shift_types_set.update(db_shift_types)
        sorted_shift_types = sorted(list(shift_types_set))
        
        def make_empty_stats():
            return {
                "shift_counts": {st: 0 for st in sorted_shift_types},
                "shift_hours": {st: 0 for st in sorted_shift_types},
                "weekday_count": 0,
                "weekday_hours": 0,
                "weekend_count": 0,
                "weekend_hours": 0,
                "total_count": 0,
                "total_hours": 0
            }
            
        cumulative_stats = {res: make_empty_stats() for res in sorted_residents}
        blocks_out = []
        
        for b in blocks:
            assigns = db.query(DBShiftAssignment).filter(DBShiftAssignment.block_id == b.id).all()
            
            # Fetch public holidays for this block's year range
            th_hol = holidays.Thailand(years=list(range(b.start_date.year, b.end_date.year + 1)))
            
            block_stats = {res: make_empty_stats() for res in sorted_residents}
            
            for a in assigns:
                r_name = a.resident_name
                if not r_name or r_name == "ADMIN":
                    continue
                if r_name not in block_stats:
                    block_stats[r_name] = make_empty_stats()
                if r_name not in cumulative_stats:
                    cumulative_stats[r_name] = make_empty_stats()
                    
                s_type = a.shift_type
                if s_type not in sorted_shift_types:
                    sorted_shift_types.append(s_type)
                    sorted_shift_types.sort()
                    for rs in [block_stats, cumulative_stats]:
                        for res_key in rs:
                            rs[res_key]["shift_counts"][s_type] = 0
                            rs[res_key]["shift_hours"][s_type] = 0
                            
                d = a.date
                is_wk = d.weekday() in (5, 6) or d in th_hol
                hours = 24 if is_wk else 16
                
                block_stats[r_name]["shift_counts"][s_type] += 1
                block_stats[r_name]["shift_hours"][s_type] += hours
                
                if is_wk:
                    block_stats[r_name]["weekend_count"] += 1
                    block_stats[r_name]["weekend_hours"] += hours
                else:
                    block_stats[r_name]["weekday_count"] += 1
                    block_stats[r_name]["weekday_hours"] += hours
                    
                block_stats[r_name]["total_count"] += 1
                block_stats[r_name]["total_hours"] += hours
                
                # Cumulative update
                cumulative_stats[r_name]["shift_counts"][s_type] += 1
                cumulative_stats[r_name]["shift_hours"][s_type] += hours
                if is_wk:
                    cumulative_stats[r_name]["weekend_count"] += 1
                    cumulative_stats[r_name]["weekend_hours"] += hours
                else:
                    cumulative_stats[r_name]["weekday_count"] += 1
                    cumulative_stats[r_name]["weekday_hours"] += hours
                cumulative_stats[r_name]["total_count"] += 1
                cumulative_stats[r_name]["total_hours"] += hours
                
            blocks_out.append({
                "id": b.id,
                "name": b.name,
                "start_date": b.start_date.isoformat(),
                "end_date": b.end_date.isoformat(),
                "stats": block_stats
            })
            
        return {
            "residents": sorted_residents,
            "shift_types": sorted_shift_types,
            "blocks": blocks_out,
            "cumulative": cumulative_stats
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to calculate comparison statistics: {str(e)}")

@app.get("/api/calendar/{ical_token}.ics")

def api_get_ical_feed(ical_token: str, db: Session = Depends(get_db)):
    mapping = db.query(DBResidentEmailMapping).filter(DBResidentEmailMapping.ical_token == ical_token).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Calendar feed not found.")
        
    ical_content = generate_ical_feed(db, mapping.resident_name)
    return Response(
        content=ical_content,
        media_type="text/calendar",
        headers={
            "Content-Disposition": f"attachment; filename=schedule_{mapping.resident_name}.ics"
        }
    )

# ==========================================
# Frontend static files mounting (Monolith)
# ==========================================

static_dir = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "../frontend/dist"))

if os.path.exists(static_dir):
    assets_dir = os.path.join(static_dir, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{catchall:path}")
    async def serve_frontend(catchall: str):
        if catchall.startswith("api") or catchall.startswith("docs") or catchall.startswith("openapi.json"):
            raise HTTPException(status_code=404, detail="Not Found")
            
        target_file = os.path.join(static_dir, catchall)
        if os.path.isfile(target_file):
            return FileResponse(target_file)
            
        index_html = os.path.join(static_dir, "index.html")
        if os.path.exists(index_html):
            return FileResponse(index_html)
            
        raise HTTPException(status_code=404, detail="Frontend build files not found.")
