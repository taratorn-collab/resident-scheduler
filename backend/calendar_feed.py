import datetime
from sqlalchemy.orm import Session
from models import DBShiftAssignment

def generate_ical_feed(db: Session, resident_name: str) -> str:
    assignments = db.query(DBShiftAssignment).filter(
        DBShiftAssignment.resident_name == resident_name
    ).order_by(DBShiftAssignment.date.asc()).all()

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//E-WANE Scheduler//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:E-WANE - {resident_name}",
        f"NAME:E-WANE - {resident_name}",
        f"X-WR-CALDESC:E-WANE shift duty calendar for {resident_name}",
        f"DESCRIPTION:E-WANE shift duty calendar for {resident_name}",
        "X-WR-TIMEZONE:Asia/Bangkok",
    ]

    for idx, a in enumerate(assignments):
        # Format dates
        start_str = a.date.strftime("%Y%m%d")
        end_str = (a.date + datetime.timedelta(days=1)).strftime("%Y%m%d")
        
        uid = f"shift_{a.id}_{start_str}@imscheduler"
        dstamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:{uid}",
            f"DTSTAMP:{dstamp}",
            f"DTSTART;VALUE=DATE:{start_str}",
            f"DTEND;VALUE=DATE:{end_str}",
            f"SUMMARY:{a.shift_type}",
            f"DESCRIPTION:E-WANE Resident Shift Duty: {a.shift_type}",
            "END:VEVENT"
        ])
        
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines)
