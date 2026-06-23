import datetime
from typing import List, Dict, Any, Tuple
from ortools.sat.python import cp_model
from models import (
    GenerateRequest, ShiftAssignmentOutput, ResidentStats, ConstraintViolation, GenerateResponse,
    ValidateRequest, ValidateResponse
)

def solve_schedule(req: GenerateRequest) -> GenerateResponse:
    # 1. Parse dates and set up time window
    start_dt = datetime.date.fromisoformat(req.start_date)
    end_dt = datetime.date.fromisoformat(req.end_date)
    
    # Generate list of days
    delta = end_dt - start_dt
    days = [start_dt + datetime.timedelta(days=i) for i in range(delta.days + 1)]
    days_str = [d.isoformat() for d in days]
    
    holidays_set = set(req.holidays)
    
    # Pre-calculate weekend/holiday status and shift hours for each day
    is_weekend_holiday = {}
    shift_hours = {}
    for d in days:
        d_str = d.isoformat()
        # 5 = Saturday, 6 = Sunday
        is_wk = d.weekday() in (5, 6) or d_str in holidays_set
        is_weekend_holiday[d_str] = is_wk
        shift_hours[d_str] = 24 if is_wk else 16

    # 2. Map shift types and their active windows
    active_shifts_by_day = {}
    for d_str in days_str:
        d_val = datetime.date.fromisoformat(d_str)
        active_shifts = []
        for s_cfg in req.shift_types:
            active = True
            if s_cfg.active_from_date:
                from_dt = datetime.date.fromisoformat(s_cfg.active_from_date)
                if d_val < from_dt:
                    active = False
            if s_cfg.active_to_date:
                to_dt = datetime.date.fromisoformat(s_cfg.active_to_date)
                if d_val > to_dt:
                    active = False
            if active:
                active_shifts.append(s_cfg.name)
        active_shifts_by_day[d_str] = active_shifts

    residents = req.residents
    resident_names = [r.name for r in residents]
    
    # Map residents to their input data
    res_map = {r.name: r for r in residents}
    
    # Identify balancing residents (exclude Vacation, Elective, Ambu rotations)
    balancing_residents = []
    for r in residents:
        rot = r.rotation.upper()
        if not any(kw in rot for kw in ("VACATION", "ELECTIVE", "AMBU")):
            balancing_residents.append(r.name)
    # If all are vacation/elective/ambu (unlikely), balance everyone to avoid division or empty lists
    if not balancing_residents:
        balancing_residents = resident_names

    # 3. Create CP Model
    model = cp_model.CpModel()
    
    # 4. Decision Variables: x[r, d, s]
    # x[r, d, s] = 1 if resident r is assigned to shift s on day d
    x = {}
    for r in resident_names:
        for d_str in days_str:
            for s in active_shifts_by_day[d_str]:
                x[r, d_str, s] = model.NewBoolVar(f"x_{r}_{d_str}_{s}")

    # 5. Core Coverage Constraints
    # Constraint: Exactly 1 resident per active shift per day
    for d_str in days_str:
        for s in active_shifts_by_day[d_str]:
            model.Add(sum(x[r, d_str, s] for r in resident_names) == 1)

    # Constraint: A resident can do at most 1 shift per day
    for r in resident_names:
        for d_str in days_str:
            active_s = active_shifts_by_day[d_str]
            if active_s:
                model.Add(sum(x[r, d_str, s] for s in active_s) <= 1)

    # Constraint: Support locked / manual assignments fixed by user
    if req.current_assignments:
        for ca in req.current_assignments:
            if ca.is_locked and ca.resident_name in resident_names:
                d_str = ca.date
                s_name = ca.shift_type
                if d_str in active_shifts_by_day and s_name in active_shifts_by_day[d_str]:
                    model.Add(x[ca.resident_name, d_str, s_name] == 1)


    # 6. Violation & Penalty Variables (for Soft / Fallback Constraints)
    # Tier 1 Fallback: Blocked Dates / Vacation Violations
    vacation_violations = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        blocked_set = set(r_input.blocked_dates)
        for d_str in days_str:
            if d_str in blocked_set:
                active_s = active_shifts_by_day[d_str]
                if active_s:
                    v_vac = model.NewBoolVar(f"v_vac_{r_name}_{d_str}")
                    # v_vac >= sum(x[r, d, s])
                    model.Add(v_vac >= sum(x[r_name, d_str, s] for s in active_s))
                    vacation_violations.append(v_vac)

    # Tier 1 Fallback: 2-day Break Violations (Rolling 3-day window)
    break_violations = []
    for r in resident_names:
        # Check within the current block
        for i in range(len(days_str) - 2):
            d1, d2, d3 = days_str[i], days_str[i+1], days_str[i+2]
            v_brk = model.NewBoolVar(f"v_brk_{r}_{d1}")
            
            s1 = sum(x[r, d1, s] for s in active_shifts_by_day[d1])
            s2 = sum(x[r, d2, s] for s in active_shifts_by_day[d2])
            s3 = sum(x[r, d3, s] for s in active_shifts_by_day[d3])
            
            # If s1 + s2 + s3 > 1, then v_brk must be 1.
            # We can model: s1 + s2 + s3 <= 1 + 2 * v_brk
            model.Add(s1 + s2 + s3 <= 1 + 2 * v_brk)
            break_violations.append(v_brk)

    # Tier 1 Fallback: Boundary break checks with previous block
    prev_boundary_violations = []
    if req.prev_assignments:
        # Map resident to their last assigned dates
        # Find dates of the previous block relative to start_dt
        prev_map = {}
        for pa in req.prev_assignments:
            try:
                pa_dt = datetime.date.fromisoformat(pa.date)
                diff_days = (start_dt - pa_dt).days
                if 1 <= diff_days <= 2:
                    prev_map.setdefault(pa.resident_name, []).append(diff_days)
            except ValueError:
                continue
        
        for r in resident_names:
            diffs = prev_map.get(r, [])
            if 1 in diffs: # Worked on start_dt - 1 day
                # Cannot work on day 1 (index 0) or day 2 (index 1)
                for day_idx in [0, 1]:
                    if day_idx < len(days_str):
                        d_str = days_str[day_idx]
                        active_s = active_shifts_by_day[d_str]
                        if active_s:
                            v_bnd = model.NewBoolVar(f"v_bnd_1_{r}_{d_str}")
                            model.Add(sum(x[r, d_str, s] for s in active_s) <= v_bnd)
                            prev_boundary_violations.append(v_bnd)
            if 2 in diffs: # Worked on start_dt - 2 days
                # Cannot work on day 1 (index 0)
                if len(days_str) > 0:
                    d_str = days_str[0]
                    active_s = active_shifts_by_day[d_str]
                    if active_s:
                        v_bnd = model.NewBoolVar(f"v_bnd_2_{r}_{d_str}")
                        model.Add(sum(x[r, d_str, s] for s in active_s) <= v_bnd)
                        prev_boundary_violations.append(v_bnd)

    # Tier 1 Fallback: Minimum 80 Hours requirement
    hours_deficit = {}
    r_hours_vars = {}
    for r in resident_names:
        # Calculate total hours variable
        r_hours = sum(
            x[r, d_str, s] * shift_hours[d_str]
            for d_str in days_str
            for s in active_shifts_by_day[d_str]
        )
        r_hours_vars[r] = r_hours
        # Deficit below 80 hours
        v_def = model.NewIntVar(0, 80, f"v_def_{r}")
        # r_hours + v_def >= 80
        model.Add(r_hours + v_def >= 80)
        hours_deficit[r] = v_def

    # Tier 2: No shift if OPD the next day (Soft Constraint)
    opd_violations = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        opd_set = set(r_input.opd_days)
        for i in range(len(days_str) - 1):
            d_str = days_str[i]
            d_next_str = days_str[i+1]
            d_next_val = datetime.date.fromisoformat(d_next_str)
            # Check if next day's weekday name matches OPD days
            next_day_name = d_next_val.strftime("%A")
            if next_day_name in opd_set:
                active_s = active_shifts_by_day[d_str]
                if active_s:
                    v_opd = model.NewBoolVar(f"v_opd_{r_name}_{d_str}")
                    model.Add(v_opd >= sum(x[r_name, d_str, s] for s in active_s))
                    opd_violations.append(v_opd)

    # Tier 2: Avoid ID, Chest on Sunday (Soft Constraint)
    sunday_rot_violations = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        rot = r_input.rotation.upper()
        if "ID" in rot or "CHEST" in rot:
            for d_str in days_str:
                d_val = datetime.date.fromisoformat(d_str)
                if d_val.weekday() == 6: # Sunday
                    active_s = active_shifts_by_day[d_str]
                    if active_s:
                        v_sun = model.NewBoolVar(f"v_sun_h_{r_name}_{d_str}")
                        model.Add(v_sun >= sum(x[r_name, d_str, s] for s in active_s))
                        sunday_rot_violations.append(v_sun)

    # Tier 2: Avoid MICU for ID/Chest on Sunday-Thursday (Soft Constraint)
    micu_weekday_rot_violations = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        rot = r_input.rotation.upper()
        if "ID" in rot or "CHEST" in rot:
            for d_str in days_str:
                d_val = datetime.date.fromisoformat(d_str)
                if d_val.weekday() in (6, 0, 1, 2, 3): # Sunday - Thursday
                    active_s = active_shifts_by_day[d_str]
                    if "MICU" in active_s:
                        v_micu_wk = model.NewBoolVar(f"v_micu_wk_{r_name}_{d_str}")
                        model.Add(v_micu_wk >= x[r_name, d_str, "MICU"])
                        micu_weekday_rot_violations.append(v_micu_wk)

    # Tier 3: Avoid Neuro, Rheumato on Sunday (Nice to Have)
    sunday_rot_nice_violations = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        rot = r_input.rotation.upper()
        if "NEURO" in rot or "RHEU" in rot:
            for d_str in days_str:
                d_val = datetime.date.fromisoformat(d_str)
                if d_val.weekday() == 6: # Sunday
                    active_s = active_shifts_by_day[d_str]
                    if active_s:
                        v_sun_n = model.NewBoolVar(f"v_sun_n_{r_name}_{d_str}")
                        model.Add(v_sun_n >= sum(x[r_name, d_str, s] for s in active_s))
                        sunday_rot_nice_violations.append(v_sun_n)

    # Tier 3: Balance shifts, total hours, and weekend hours among balancing residents
    # We will minimize (max - min) differences
    balance_terms = []
    
    # 7.1 Balance each shift type count
    for s_cfg in req.shift_types:
        s_name = s_cfg.name
        # Count for each balancing resident
        counts = {}
        for r in balancing_residents:
            counts[r] = sum(
                x[r, d_str, s_name]
                for d_str in days_str
                if s_name in active_shifts_by_day[d_str]
            )
        
        if counts:
            # We define max_count and min_count variables
            max_c = model.NewIntVar(0, len(days_str), f"max_c_{s_name}")
            min_c = model.NewIntVar(0, len(days_str), f"min_c_{s_name}")
            for r in balancing_residents:
                model.Add(max_c >= counts[r])
                model.Add(min_c <= counts[r])
            
            diff_c = model.NewIntVar(0, len(days_str), f"diff_c_{s_name}")
            model.Add(diff_c == max_c - min_c)
            balance_terms.append((diff_c, 1000)) # term, weight

    # 7.2 Balance total hours
    total_hours_vars = {}
    for r in balancing_residents:
        total_hours_vars[r] = r_hours_vars[r]
    
    if total_hours_vars:
        max_h = model.NewIntVar(0, 24 * len(days_str), "max_h")
        min_h = model.NewIntVar(0, 24 * len(days_str), "min_h")
        for r in balancing_residents:
            model.Add(max_h >= total_hours_vars[r])
            model.Add(min_h <= total_hours_vars[r])
        
        diff_h = model.NewIntVar(0, 24 * len(days_str), "diff_h")
        model.Add(diff_h == max_h - min_h)
        balance_terms.append((diff_h, 500))

    # 7.3 Balance weekend hours
    weekend_hours_vars = {}
    for r in balancing_residents:
        weekend_hours_vars[r] = sum(
            x[r, d_str, s] * shift_hours[d_str]
            for d_str in days_str
            if is_weekend_holiday[d_str]
            for s in active_shifts_by_day[d_str]
        )
    
    if weekend_hours_vars:
        max_wh = model.NewIntVar(0, 24 * len(days_str), "max_wh")
        min_wh = model.NewIntVar(0, 24 * len(days_str), "min_wh")
        for r in balancing_residents:
            model.Add(max_wh >= weekend_hours_vars[r])
            model.Add(min_wh <= weekend_hours_vars[r])
        
        diff_wh = model.NewIntVar(0, 24 * len(days_str), "diff_wh")
        model.Add(diff_wh == max_wh - min_wh)
        balance_terms.append((diff_wh, 500))

    # 7.4 Dynamic Hours Cap Calculation
    total_required_hours = sum(
        shift_hours[d_str]
        for d_str in days_str
        for s in active_shifts_by_day[d_str]
    )
    num_residents = len(resident_names)
    mean_hours = total_required_hours / num_residents if num_residents > 0 else 0.0

    v_excess_soft_list = []
    v_excess_hard_list = []
    
    for r_name in resident_names:
        r_input = res_map[r_name]
        rot = r_input.rotation.upper()
        
        # Calculate limits based on rotation
        if "VACATION" in rot:
            soft_limit = 80
            hard_limit = 80
        elif any(kw in rot for kw in ("AMBU", "ELECTIVE")):
            soft_limit = max(80, int(round(mean_hours - 12)))
            hard_limit = max(80, int(round(mean_hours + 12)))
        else:
            soft_limit = max(80, int(round(mean_hours + 16)))
            hard_limit = max(80, int(round(mean_hours + 32)))
            
        r_hours = r_hours_vars[r_name]
        
        # CP-SAT Variables for excess hours
        v_excess_soft = model.NewIntVar(0, 24 * len(days_str), f"v_excess_soft_{r_name}")
        model.Add(v_excess_soft >= r_hours - soft_limit)
        v_excess_soft_list.append(v_excess_soft)
        
        v_excess_hard = model.NewIntVar(0, 24 * len(days_str), f"v_excess_hard_{r_name}")
        model.Add(v_excess_hard >= r_hours - hard_limit)
        v_excess_hard_list.append(v_excess_hard)

    # 8. Define Objective Function (Weighted Sum of Penalties)
    # Tier 1 penalties are huge to make them hard constraints unless impossible
    objective = (
        10000000 * sum(vacation_violations) +
        5000000 * sum(break_violations) +
        5000000 * sum(prev_boundary_violations) +
        100000 * sum(hours_deficit.values()) +
        100000 * sum(v_excess_hard_list) +  # Hard Limit penalty
        10000 * sum(v_excess_soft_list) +    # Soft Limit penalty
        5000 * sum(opd_violations) +
        3000 * sum(micu_weekday_rot_violations) +
        2000 * sum(sunday_rot_violations) +
        500 * sum(sunday_rot_nice_violations) +
        sum(term * weight for term, weight in balance_terms)
    )
    
    model.Minimize(objective)

    # 9. Solve
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0  # Set limit to avoid blocking
    status = solver.Solve(model)

    # 10. Process Results
    assignments_out = []
    violations_out = []
    resident_stats_out = []
    
    is_fallback = False
    
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Map (date, shift_type) -> is_locked from request
        locked_map = {}
        if req.current_assignments:
            for ca in req.current_assignments:
                if ca.is_locked:
                    locked_map[(ca.date, ca.shift_type)] = True

        # 10.1 Collect assignments
        for d_str in days_str:
            d_val = datetime.date.fromisoformat(d_str)
            for s in active_shifts_by_day[d_str]:
                for r in resident_names:
                    if solver.Value(x[r, d_str, s]) == 1:
                        is_locked = locked_map.get((d_str, s), False)
                        assignments_out.append(ShiftAssignmentOutput(
                            date=d_str,
                            day_name=d_val.strftime("%A"),
                            shift_type=s,
                            resident_name=r,
                            is_locked=is_locked,
                            is_weekend=is_weekend_holiday[d_str],
                            hours=shift_hours[d_str]
                        ))


        # 10.2 Check for violations
        # Vacation violations
        for r_name in resident_names:
            r_input = res_map[r_name]
            blocked_set = set(r_input.blocked_dates)
            for d_str in days_str:
                if d_str in blocked_set:
                    active_s = active_shifts_by_day[d_str]
                    for s in active_s:
                        if solver.Value(x[r_name, d_str, s]) == 1:
                            is_fallback = True
                            violations_out.append(ConstraintViolation(
                                type="HARD",
                                rule="Vacation / Blocked Out Date Violation",
                                resident_name=r_name,
                                date=d_str,
                                details=f"{r_name} was assigned to shift '{s}' on blocked date {d_str}."
                            ))

        # Break violations
        for r in resident_names:
            for i in range(len(days_str) - 2):
                d1, d2, d3 = days_str[i], days_str[i+1], days_str[i+2]
                s1 = sum(solver.Value(x[r, d1, s]) for s in active_shifts_by_day[d1])
                s2 = sum(solver.Value(x[r, d2, s]) for s in active_shifts_by_day[d2])
                s3 = sum(solver.Value(x[r, d3, s]) for s in active_shifts_by_day[d3])
                if s1 + s2 + s3 > 1:
                    is_fallback = True
                    violations_out.append(ConstraintViolation(
                        type="HARD",
                        rule="2 Break Days Violation",
                        resident_name=r,
                        date=d1,
                        details=f"{r} worked multiple shifts in a 3-day window around {d1}."
                    ))

        # Boundary violations
        if req.prev_assignments:
            # We check if boundary variables are activated
            prev_map = {}
            for pa in req.prev_assignments:
                try:
                    pa_dt = datetime.date.fromisoformat(pa.date)
                    diff_days = (start_dt - pa_dt).days
                    if 1 <= diff_days <= 2:
                        prev_map.setdefault(pa.resident_name, []).append((diff_days, pa.date))
                except ValueError:
                    continue
            
            for r in resident_names:
                diffs_info = prev_map.get(r, [])
                for diff, p_date in diffs_info:
                    if diff == 1:
                        # check day 1 and 2
                        for idx, d_str in enumerate(days_str[:2]):
                            s_cnt = sum(solver.Value(x[r, d_str, s]) for s in active_shifts_by_day[d_str])
                            if s_cnt > 0:
                                is_fallback = True
                                violations_out.append(ConstraintViolation(
                                    type="HARD",
                                    rule="Previous Block Boundary Violation",
                                    resident_name=r,
                                    date=d_str,
                                    details=f"{r} worked on previous block date {p_date} and is assigned to work on {d_str} (violating 2-day break)."
                                ))
                    elif diff == 2:
                        # check day 1
                        if len(days_str) > 0:
                            d_str = days_str[0]
                            s_cnt = sum(solver.Value(x[r, d_str, s]) for s in active_shifts_by_day[d_str])
                            if s_cnt > 0:
                                is_fallback = True
                                violations_out.append(ConstraintViolation(
                                    type="HARD",
                                    rule="Previous Block Boundary Violation",
                                    resident_name=r,
                                    date=d_str,
                                    details=f"{r} worked on previous block date {p_date} and is assigned to work on {d_str} (violating 2-day break)."
                                ))

        # Hours Deficit violations
        for r in resident_names:
            deficit = solver.Value(hours_deficit[r])
            if deficit > 0:
                is_fallback = True
                violations_out.append(ConstraintViolation(
                    type="HARD",
                    rule="Minimum 80 Hours Violation",
                    resident_name=r,
                    details=f"{r} falls short of the 80-hour minimum by {deficit} hours."
                ))

        # Hours Cap violations check
        for r_name in resident_names:
            r_input = res_map[r_name]
            rot = r_input.rotation.upper()
            
            if "VACATION" in rot:
                soft_limit = 80
                hard_limit = 80
            elif any(kw in rot for kw in ("AMBU", "ELECTIVE")):
                soft_limit = max(80, int(round(mean_hours - 12)))
                hard_limit = max(80, int(round(mean_hours + 12)))
            else:
                soft_limit = max(80, int(round(mean_hours + 16)))
                hard_limit = max(80, int(round(mean_hours + 32)))
                
            total_h = sum(
                solver.Value(x[r_name, d_str, s]) * shift_hours[d_str]
                for d_str in days_str
                for s in active_shifts_by_day[d_str]
            )
            
            if total_h > hard_limit:
                is_fallback = True
                violations_out.append(ConstraintViolation(
                    type="HARD",
                    rule="Hard Hours Cap Violation",
                    resident_name=r_name,
                    details=f"{r_name} worked {total_h} hours, which exceeds the hard limit of {hard_limit} hours."
                ))
            elif total_h > soft_limit:
                violations_out.append(ConstraintViolation(
                    type="SOFT",
                    rule="Soft Hours Cap Violation",
                    resident_name=r_name,
                    details=f"{r_name} worked {total_h} hours, which exceeds the soft limit of {soft_limit} hours."
                ))

        # OPD violations
        for r_name in resident_names:
            r_input = res_map[r_name]
            opd_set = set(r_input.opd_days)
            for i in range(len(days_str) - 1):
                d_str = days_str[i]
                d_next_str = days_str[i+1]
                d_next_val = datetime.date.fromisoformat(d_next_str)
                next_day_name = d_next_val.strftime("%A")
                if next_day_name in opd_set:
                    active_s = active_shifts_by_day[d_str]
                    s_cnt = sum(solver.Value(x[r_name, d_str, s]) for s in active_s)
                    if s_cnt > 0:
                        violations_out.append(ConstraintViolation(
                            type="SOFT",
                            rule="OPD The Next Day Violation",
                            resident_name=r_name,
                            date=d_str,
                            details=f"{r_name} has OPD on {next_day_name} ({d_next_str}) but was assigned a shift on {d_str}."
                        ))

        # ID/Chest on Sunday violations
        for r_name in resident_names:
            r_input = res_map[r_name]
            rot = r_input.rotation.upper()
            if "ID" in rot or "CHEST" in rot:
                for d_str in days_str:
                    d_val = datetime.date.fromisoformat(d_str)
                    if d_val.weekday() == 6: # Sunday
                        active_s = active_shifts_by_day[d_str]
                        s_cnt = sum(solver.Value(x[r_name, d_str, s]) for s in active_s)
                        if s_cnt > 0:
                            violations_out.append(ConstraintViolation(
                                type="SOFT",
                                rule="ID/Chest Rotation on Sunday Violation",
                                resident_name=r_name,
                                date=d_str,
                                details=f"{r_name} is on rotation '{r_input.rotation}' but was assigned a Sunday shift on {d_str}."
                            ))

        # MICU on Weekday for ID/Chest violations
        for r_name in resident_names:
            r_input = res_map[r_name]
            rot = r_input.rotation.upper()
            if "ID" in rot or "CHEST" in rot:
                for d_str in days_str:
                    d_val = datetime.date.fromisoformat(d_str)
                    if d_val.weekday() in (6, 0, 1, 2, 3): # Sunday - Thursday
                        active_s = active_shifts_by_day[d_str]
                        if "MICU" in active_s:
                            if solver.Value(x[r_name, d_str, "MICU"]) == 1:
                                violations_out.append(ConstraintViolation(
                                    type="SOFT",
                                    rule="MICU on Weekday for ID/Chest Violation",
                                    resident_name=r_name,
                                    date=d_str,
                                    details=f"{r_name} is on '{r_input.rotation}' rotation but was assigned MICU on {d_val.strftime('%A')} ({d_str})."
                                ))

        # Neuro/Rheu on Sunday violations (Nice to have)
        for r_name in resident_names:
            r_input = res_map[r_name]
            rot = r_input.rotation.upper()
            if "NEURO" in rot or "RHEU" in rot:
                for d_str in days_str:
                    d_val = datetime.date.fromisoformat(d_str)
                    if d_val.weekday() == 6: # Sunday
                        active_s = active_shifts_by_day[d_str]
                        s_cnt = sum(solver.Value(x[r_name, d_str, s]) for s in active_s)
                        if s_cnt > 0:
                            violations_out.append(ConstraintViolation(
                                type="NICE_TO_HAVE",
                                rule="Neuro/Rheumato Rotation on Sunday Violation",
                                resident_name=r_name,
                                date=d_str,
                                details=f"{r_name} is on rotation '{r_input.rotation}' but was assigned a Sunday shift on {d_str}."
                            ))

        # 10.3 Calculate resident stats
        for r_name in resident_names:
            r_input = res_map[r_name]
            
            # Hours calculations
            total_h = 0
            weekday_h = 0
            weekend_h = 0
            shift_counts = {s.name: 0 for s in req.shift_types}
            
            for d_str in days_str:
                for s in active_shifts_by_day[d_str]:
                    if solver.Value(x[r_name, d_str, s]) == 1:
                        h = shift_hours[d_str]
                        total_h += h
                        if is_weekend_holiday[d_str]:
                            weekend_h += h
                        else:
                            weekday_h += h
                        shift_counts[s] = shift_counts.get(s, 0) + 1
            
            # Check individual violations for flag
            has_vac = any(v.resident_name == r_name and v.rule.startswith("Vacation") for v in violations_out)
            has_brk = any(v.resident_name == r_name and (v.rule.startswith("2 Break") or v.rule.startswith("Previous Block")) for v in violations_out)
            has_hrs = total_h < 80
            
            resident_stats_out.append(ResidentStats(
                name=r_name,
                rotation=r_input.rotation,
                total_hours=total_h,
                weekday_hours=weekday_h,
                weekend_hours=weekend_h,
                shift_counts=shift_counts,
                has_vacation_violation=has_vac,
                has_break_violation=has_brk,
                has_hours_violation=has_hrs
            ))
            
        status_str = "FALLBACK" if is_fallback else "SUCCESS"
    else:
        status_str = "INFEASIBLE"
        # Return empty lists or try to explain
        
    return GenerateResponse(
        status=status_str,
        block_name=req.block_name,
        start_date=req.start_date,
        end_date=req.end_date,
        assignments=assignments_out,
        violations=violations_out,
        resident_stats=resident_stats_out
    )

def validate_schedule(req: ValidateRequest) -> ValidateResponse:
    # 1. Parse dates and setup windows
    start_dt = datetime.date.fromisoformat(req.start_date)
    end_dt = datetime.date.fromisoformat(req.end_date)
    
    delta = end_dt - start_dt
    days = [start_dt + datetime.timedelta(days=i) for i in range(delta.days + 1)]
    days_str = [d.isoformat() for d in days]
    
    holidays_set = set(req.holidays)
    is_weekend_holiday = {}
    shift_hours = {}
    for d in days:
        d_str = d.isoformat()
        is_wk = d.weekday() in (5, 6) or d_str in holidays_set
        is_weekend_holiday[d_str] = is_wk
        shift_hours[d_str] = 24 if is_wk else 16

    # 2. Map shift types and their active windows
    active_shifts_by_day = {}
    for d_str in days_str:
        d_val = datetime.date.fromisoformat(d_str)
        active_shifts = []
        for s_cfg in req.shift_types:
            active = True
            if s_cfg.active_from_date:
                from_dt = datetime.date.fromisoformat(s_cfg.active_from_date)
                if d_val < from_dt:
                    active = False
            if s_cfg.active_to_date:
                to_dt = datetime.date.fromisoformat(s_cfg.active_to_date)
                if d_val > to_dt:
                    active = False
            if active:
                active_shifts.append(s_cfg.name)
        active_shifts_by_day[d_str] = active_shifts

    residents = req.residents
    resident_names = [r.name for r in residents]
    res_map = {r.name: r for r in residents}
    
    total_required_hours = sum(
        shift_hours[d_str]
        for d_str in days_str
        for s in active_shifts_by_day[d_str]
    )
    num_residents = len(resident_names)
    mean_hours = total_required_hours / num_residents if num_residents > 0 else 0.0
    
    # Organize assignments by resident
    assignments_by_res = {r: [] for r in resident_names}
    
    for a in req.assignments:
        if a.resident_name in assignments_by_res:
            assignments_by_res[a.resident_name].append(a)

    violations = []
    
    # Validate each resident's schedule
    for r_name in resident_names:
        r_input = res_map[r_name]
        r_assigns = sorted(assignments_by_res[r_name], key=lambda x: x.date)
        
        # 1. Check vacations / blocked dates
        blocked_set = set(r_input.blocked_dates)
        for a in r_assigns:
            if a.date in blocked_set:
                violations.append(ConstraintViolation(
                    type="HARD",
                    rule="Vacation / Blocked Out Date Violation",
                    resident_name=r_name,
                    date=a.date,
                    details=f"{r_name} is assigned to shift '{a.shift_type}' on blocked date {a.date}."
                ))
        
        # 2. Check 2 break days between shifts (rolling window)
        assigned_dates = []
        for a in r_assigns:
            try:
                assigned_dates.append(datetime.date.fromisoformat(a.date))
            except ValueError:
                continue
                
        for i in range(len(assigned_dates) - 1):
            d1 = assigned_dates[i]
            d2 = assigned_dates[i+1]
            diff = (d2 - d1).days
            if diff < 3:
                violations.append(ConstraintViolation(
                    type="HARD",
                    rule="2 Break Days Violation",
                    resident_name=r_name,
                    date=d1.isoformat(),
                    details=f"{r_name} worked shifts on {d1} and {d2} with only {diff-1} break day(s) in between."
                ))

        # 3. Check boundary break checks with previous block
        if req.prev_assignments:
            prev_map = {}
            for pa in req.prev_assignments:
                try:
                    pa_dt = datetime.date.fromisoformat(pa.date)
                    diff_days = (start_dt - pa_dt).days
                    if 1 <= diff_days <= 2:
                        prev_map.setdefault(pa.resident_name, []).append((diff_days, pa.date))
                except ValueError:
                    continue
            
            diffs_info = prev_map.get(r_name, [])
            for diff, p_date in diffs_info:
                for a in r_assigns:
                    a_dt = datetime.date.fromisoformat(a.date)
                    gap = (a_dt - datetime.date.fromisoformat(p_date)).days
                    if gap < 3:
                        violations.append(ConstraintViolation(
                            type="HARD",
                            rule="Previous Block Boundary Violation",
                            resident_name=r_name,
                            date=a.date,
                            details=f"{r_name} worked on previous block date {p_date} and is assigned to work on {a.date} (violating 2-day break)."
                        ))

        # 4. Check OPD the next day
        opd_set = set(r_input.opd_days)
        for a in r_assigns:
            a_dt = datetime.date.fromisoformat(a.date)
            d_next = a_dt + datetime.timedelta(days=1)
            next_day_name = d_next.strftime("%A")
            if next_day_name in opd_set:
                violations.append(ConstraintViolation(
                    type="SOFT",
                    rule="OPD The Next Day Violation",
                    resident_name=r_name,
                    date=a.date,
                    details=f"{r_name} has OPD on {next_day_name} ({d_next.isoformat()}) but was assigned a shift on {a.date}."
                ))

        # 5. Check ID, Chest on Sunday
        rot = r_input.rotation.upper()
        if "ID" in rot or "CHEST" in rot:
            for a in r_assigns:
                a_dt = datetime.date.fromisoformat(a.date)
                if a_dt.weekday() == 6: # Sunday
                    violations.append(ConstraintViolation(
                        type="SOFT",
                        rule="ID/Chest Rotation on Sunday Violation",
                        resident_name=r_name,
                        date=a.date,
                        details=f"{r_name} is on rotation '{r_input.rotation}' but was assigned a Sunday shift on {a.date}."
                    ))

        # 6. Check MICU on Weekday for ID/Chest (Sunday - Thursday)
        if "ID" in rot or "CHEST" in rot:
            for a in r_assigns:
                if a.shift_type == "MICU":
                    a_dt = datetime.date.fromisoformat(a.date)
                    if a_dt.weekday() in (6, 0, 1, 2, 3): # Sunday - Thursday
                        violations.append(ConstraintViolation(
                            type="SOFT",
                            rule="MICU on Weekday for ID/Chest Violation",
                            resident_name=r_name,
                            date=a.date,
                            details=f"{r_name} is on '{r_input.rotation}' rotation but was assigned MICU on {a_dt.strftime('%A')} ({a.date})."
                        ))

        # 7. Check Neuro, Rheumato on Sunday (Nice to have)
        if "NEURO" in rot or "RHEU" in rot:
            for a in r_assigns:
                a_dt = datetime.date.fromisoformat(a.date)
                if a_dt.weekday() == 6: # Sunday
                    violations.append(ConstraintViolation(
                        type="NICE_TO_HAVE",
                        rule="Neuro/Rheumato Rotation on Sunday Violation",
                        resident_name=r_name,
                        date=a.date,
                        details=f"{r_name} is on rotation '{r_input.rotation}' but was assigned a Sunday shift on {a.date}."
                    ))

    # Calculate stats
    resident_stats_out = []
    for r_name in resident_names:
        r_input = res_map[r_name]
        r_assigns = assignments_by_res[r_name]
        
        total_h = sum(a.hours for a in r_assigns)
        weekday_h = sum(a.hours for a in r_assigns if not is_weekend_holiday[a.date])
        weekend_h = sum(a.hours for a in r_assigns if is_weekend_holiday[a.date])
        
        shift_counts = {s.name: 0 for s in req.shift_types}
        for a in r_assigns:
            shift_counts[a.shift_type] = shift_counts.get(a.shift_type, 0) + 1
            
        # Check individual violations for flag
        has_vac = any(v.resident_name == r_name and v.rule.startswith("Vacation") for v in violations)
        has_brk = any(v.resident_name == r_name and (v.rule.startswith("2 Break") or v.rule.startswith("Previous Block")) for v in violations)
        has_hrs = total_h < 80
        
        if has_hrs:
            violations.append(ConstraintViolation(
                type="HARD",
                rule="Minimum 80 Hours Violation",
                resident_name=r_name,
                details=f"{r_name} falls short of the 80-hour minimum (currently has {total_h} hours)."
            ))
            
        # Check hours limits
        rot = r_input.rotation.upper()
        if "VACATION" in rot:
            soft_limit = 80
            hard_limit = 80
        elif any(kw in rot for kw in ("AMBU", "ELECTIVE")):
            soft_limit = max(80, int(round(mean_hours - 12)))
            hard_limit = max(80, int(round(mean_hours + 12)))
        else:
            soft_limit = max(80, int(round(mean_hours + 16)))
            hard_limit = max(80, int(round(mean_hours + 32)))
            
        if total_h > hard_limit:
            violations.append(ConstraintViolation(
                type="HARD",
                rule="Hard Hours Cap Violation",
                resident_name=r_name,
                details=f"{r_name} worked {total_h} hours, which exceeds the hard limit of {hard_limit} hours."
            ))
        elif total_h > soft_limit:
            violations.append(ConstraintViolation(
                type="SOFT",
                rule="Soft Hours Cap Violation",
                resident_name=r_name,
                details=f"{r_name} worked {total_h} hours, which exceeds the soft limit of {soft_limit} hours."
            ))
            
        resident_stats_out.append(ResidentStats(
            name=r_name,
            rotation=r_input.rotation,
            total_hours=total_h,
            weekday_hours=weekday_h,
            weekend_hours=weekend_h,
            shift_counts=shift_counts,
            has_vacation_violation=has_vac,
            has_break_violation=has_brk,
            has_hours_violation=has_hrs
        ))

    return ValidateResponse(
        violations=violations,
        resident_stats=resident_stats_out
    )

