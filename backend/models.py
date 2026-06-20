from sqlalchemy import Column, Integer, String, Date, Boolean, ForeignKey
from sqlalchemy.orm import relationship
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from datetime import date

from database import Base

# ==========================================
# SQLAlchemy Models
# ==========================================

class DBBlock(Base):
    __tablename__ = "blocks"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String, unique=True, index=True)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)

    resident_infos = relationship("DBResidentBlockInfo", back_populates="block", cascade="all, delete-orphan")
    assignments = relationship("DBShiftAssignment", back_populates="block", cascade="all, delete-orphan")

class DBResidentBlockInfo(Base):
    __tablename__ = "resident_block_info"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    block_id = Column(Integer, ForeignKey("blocks.id", ondelete="CASCADE"), nullable=False)
    resident_name = Column(String, nullable=False)
    rotation = Column(String, nullable=False)  # e.g., "ID", "Ambu", "Vacation", "Elective"
    opd_days = Column(String, nullable=True)     # comma-separated day names e.g., "Monday,Wednesday"
    blocked_dates = Column(String, nullable=True) # comma-separated date strings "YYYY-MM-DD"
    
    block = relationship("DBBlock", back_populates="resident_infos")

class DBShiftAssignment(Base):
    __tablename__ = "shift_assignments"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    block_id = Column(Integer, ForeignKey("blocks.id", ondelete="CASCADE"), nullable=False)
    date = Column(Date, nullable=False)
    shift_type = Column(String, nullable=False)  # e.g., "MICU", "CCU"
    resident_name = Column(String, nullable=False)
    is_locked = Column(Boolean, default=False)

    block = relationship("DBBlock", back_populates="assignments")


# ==========================================
# Pydantic Models
# ==========================================

class ResidentInput(BaseModel):
    name: str
    rotation: str  # Rotation name (e.g. "ID", "Chest", "Elective", "Vacation", etc.)
    opd_days: List[str] = []  # e.g. ["Monday", "Friday"]
    blocked_dates: List[str] = []  # e.g. ["2026-07-04"] (Blocked out due to personal/vacation)

class ShiftTypeConfig(BaseModel):
    name: str  # e.g. "MICU", "CCU", "ต่างแผนก", "แยกโรค"
    display_name: str
    active_from_date: Optional[str] = None  # YYYY-MM-DD
    active_to_date: Optional[str] = None    # YYYY-MM-DD

class PreviousAssignmentInput(BaseModel):
    date: str  # YYYY-MM-DD
    shift_type: str
    resident_name: str

class ShiftAssignmentOutput(BaseModel):
    date: str  # YYYY-MM-DD
    day_name: str # e.g. "Monday"
    shift_type: str
    resident_name: str
    is_locked: bool = False
    is_weekend: bool = False
    hours: int = 16

class GenerateRequest(BaseModel):
    block_name: str
    start_date: str  # YYYY-MM-DD
    end_date: str    # YYYY-MM-DD
    residents: List[ResidentInput]
    shift_types: List[ShiftTypeConfig]
    holidays: List[str] = []  # List of YYYY-MM-DD
    prev_assignments: List[PreviousAssignmentInput] = []
    current_assignments: List[ShiftAssignmentOutput] = []


class ResidentStats(BaseModel):
    name: str
    rotation: str
    total_hours: int
    weekday_hours: int
    weekend_hours: int
    shift_counts: Dict[str, int]  # Shift Type name -> Count
    has_vacation_violation: bool = False
    has_break_violation: bool = False
    has_hours_violation: bool = False

class ConstraintViolation(BaseModel):
    type: str  # "HARD", "SOFT", "NICE_TO_HAVE"
    rule: str  # Description of the rule broken
    resident_name: str
    date: Optional[str] = None
    details: str

class GenerateResponse(BaseModel):
    status: str  # "SUCCESS", "FALLBACK"
    block_name: str
    start_date: str
    end_date: str
    assignments: List[ShiftAssignmentOutput]
    violations: List[ConstraintViolation]
    resident_stats: List[ResidentStats]

class ValidateRequest(BaseModel):
    start_date: str  # YYYY-MM-DD
    end_date: str    # YYYY-MM-DD
    residents: List[ResidentInput]
    shift_types: List[ShiftTypeConfig]
    holidays: List[str] = []
    prev_assignments: List[PreviousAssignmentInput] = []
    assignments: List[ShiftAssignmentOutput]

class ValidateResponse(BaseModel):
    violations: List[ConstraintViolation]
    resident_stats: List[ResidentStats]

# ==========================================
# Authentication & Mapping Models
# ==========================================

class DBResidentEmailMapping(Base):
    __tablename__ = "resident_email_mappings"
    email = Column(String, primary_key=True, index=True)
    resident_name = Column(String, unique=True, index=True, nullable=False)
    ical_token = Column(String, unique=True, index=True, nullable=False)

class DBResidentBlockedDate(Base):
    __tablename__ = "resident_blocked_dates"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    resident_name = Column(String, index=True, nullable=False)
    blocked_date = Column(Date, nullable=False)

class AuthRequest(BaseModel):
    id_token: str

class ProfileMappingRequest(BaseModel):
    resident_name: str

class BlockedDateRequest(BaseModel):
    date: str

class BlockedDatesSyncRequest(BaseModel):
    dates: List[str]


