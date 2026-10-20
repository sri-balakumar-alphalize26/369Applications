from odoo import models, fields, api, exceptions
from datetime import date, timedelta
from markupsafe import Markup, escape
import calendar
import io
import base64
import logging
import math

_logger = logging.getLogger(__name__)


def minutes_to_hm(total_minutes):
    """Convert minutes to H:MM format."""
    if not total_minutes or total_minutes <= 0:
        return '0:00'
    total_minutes = int(total_minutes)
    hours = total_minutes // 60
    mins = total_minutes % 60
    return f'{hours}:{mins:02d}'


# ──────────────────────────────────────────────────────────────
#  WIZARD – collects filter parameters
# ──────────────────────────────────────────────────────────────
class EmployeeReportWizard(models.TransientModel):
    _name = 'hr.employee.report.wizard'
    _description = 'Employee Report Wizard'

    month = fields.Selection([
        ('1', 'January'), ('2', 'February'), ('3', 'March'),
        ('4', 'April'), ('5', 'May'), ('6', 'June'),
        ('7', 'July'), ('8', 'August'), ('9', 'September'),
        ('10', 'October'), ('11', 'November'), ('12', 'December'),
    ], string='Month', required=True,
       default=lambda self: str(date.today().month))

    year = fields.Integer(
        string='Year', required=True,
        default=lambda self: date.today().year,
    )

    company_id = fields.Many2one(
        'res.company', string='Company',
        default=lambda self: self.env.company,
        required=True,
    )

    employee_select = fields.Selection([
        ('all', 'All Employees'),
        ('selected', 'Selected Employees'),
    ], string='Employees', default='all', required=True)

    employee_ids = fields.Many2many('hr.employee', string='Select Employees')
    department_id = fields.Many2one('hr.department', string='Department')

    def action_generate_report(self):
        self.ensure_one()
        month = int(self.month)
        year = self.year
        d_from = date(year, month, 1)
        last_day = calendar.monthrange(year, month)[1]
        d_to = date(year, month, last_day)

        report = self.env['hr.employee.report'].create({
            'month': self.month,
            'year': year,
            'date_from': d_from,
            'date_to': d_to,
            'company_id': self.company_id.id,
            'employee_select': self.employee_select,
            'employee_ids': [(6, 0, self.employee_ids.ids)] if self.employee_select == 'selected' else [(5,)],
            'department_id': self.department_id.id or False,
        })
        report.action_refresh()

        return {
            'name': report.name,
            'type': 'ir.actions.act_window',
            'res_model': 'hr.employee.report',
            'res_id': report.id,
            'view_mode': 'form',
            'target': 'current',
        }


# ──────────────────────────────────────────────────────────────
#  REPORT – main model that stores parameters and lines
# ──────────────────────────────────────────────────────────────
class EmployeeReport(models.Model):
    _name = 'hr.employee.report'
    _description = 'Employee Monthly Report'
    _order = 'create_date desc'

    name = fields.Char(string='Report Name', compute='_compute_name', store=True)

    # ── Parameters ───────────────────────────────────────────
    month = fields.Selection([
        ('1', 'January'), ('2', 'February'), ('3', 'March'),
        ('4', 'April'), ('5', 'May'), ('6', 'June'),
        ('7', 'July'), ('8', 'August'), ('9', 'September'),
        ('10', 'October'), ('11', 'November'), ('12', 'December'),
    ], string='Month')
    year = fields.Integer(string='Year')
    date_from = fields.Date(string='From', required=True)
    date_to = fields.Date(string='To', required=True)
    company_id = fields.Many2one('res.company', string='Company')
    currency_id = fields.Many2one(
        'res.currency', string='Currency',
        related='company_id.currency_id', readonly=True,
    )
    employee_select = fields.Selection([
        ('all', 'All Employees'),
        ('selected', 'Selected Employees'),
    ], string='Employee Filter', default='all')
    employee_ids = fields.Many2many('hr.employee', string='Employees')
    department_id = fields.Many2one('hr.department', string='Department')

    # ── Lines ────────────────────────────────────────────────
    summary_line_ids = fields.One2many(
        'hr.employee.report.summary.line', 'report_id', string='Employee Summary',
    )
    detail_line_ids = fields.One2many(
        'hr.employee.report.detail.line', 'report_id', string='Detailed Entries',
    )

    # ── Grand Totals (computed) ──────────────────────────────
    grand_late_deduction = fields.Float(
        compute='_compute_grand_totals', string='Total Late Deductions',
    )
    grand_leave_deduction = fields.Float(
        compute='_compute_grand_totals', string='Total Leave Deductions',
    )
    grand_total_deduction = fields.Float(
        compute='_compute_grand_totals', string='Grand Total Deductions',
    )
    grand_wage = fields.Float(
        compute='_compute_grand_totals', string='Total Wages',
    )
    grand_final_amount = fields.Float(
        compute='_compute_grand_totals', string='Grand Final Amount',
    )

    # ── Computed Fields ──────────────────────────────────────
    @api.depends('month', 'year')
    def _compute_name(self):
        month_names = dict(self._fields['month'].selection)
        for rec in self:
            if rec.month and rec.year:
                rec.name = f"Employee Report - {month_names.get(rec.month, '')} {rec.year}"
            else:
                rec.name = 'Employee Report'

    @api.depends('summary_line_ids.late_deduction', 'summary_line_ids.leave_deduction',
                 'summary_line_ids.total_deduction', 'summary_line_ids.wage',
                 'summary_line_ids.final_amount')
    def _compute_grand_totals(self):
        for rec in self:
            lines = rec.summary_line_ids
            rec.grand_late_deduction = sum(lines.mapped('late_deduction'))
            rec.grand_leave_deduction = sum(lines.mapped('leave_deduction'))
            rec.grand_total_deduction = sum(lines.mapped('total_deduction'))
            rec.grand_wage = sum(lines.mapped('wage'))
            rec.grand_final_amount = sum(lines.mapped('final_amount'))

    # ── Refresh / Generate Data ──────────────────────────────
    def action_refresh(self):
        for rec in self:
            rec.summary_line_ids.unlink()
            rec.detail_line_ids.unlink()
            rec._generate_data()
        return True

    def _get_employees(self):
        domain = [('company_id', '=', self.company_id.id)]
        if self.employee_select == 'selected' and self.employee_ids:
            domain.append(('id', 'in', self.employee_ids.ids))
        if self.department_id:
            domain.append(('department_id', '=', self.department_id.id))
        return self.env['hr.employee'].search(domain)

    def _fix_jsonb_columns(self):
        cr = self.env.cr
        fixes = [
            ('hr_employee_report_summary_line', ['employee_name', 'department_name']),
            ('hr_employee_report_detail_line', ['employee_name']),
        ]
        for table, cols in fixes:
            for col in cols:
                cr.execute("""
                    SELECT data_type FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                """, (table, col))
                result = cr.fetchone()
                if result and result[0] in ('json', 'jsonb'):
                    _logger.info('Fixing JSONB column: %s.%s → varchar', table, col)
                    cr.execute(
                        'ALTER TABLE "%s" DROP COLUMN "%s"' % (table, col)
                    )
                    cr.execute(
                        'ALTER TABLE "%s" ADD COLUMN "%s" varchar' % (table, col)
                    )

    def _generate_data(self):
        """Build summary and detail lines from hr.attendance + hr.leave.request."""
        self.ensure_one()
        self._fix_jsonb_columns()

        employees = self._get_employees()
        d_from = self.date_from
        d_to = self.date_to

        Config = self.env['hr.attendance.late.config']
        Slab = self.env['hr.late.deduction.slab']
        Holiday = self.env['hr.public.holiday']
        summary_vals = []
        detail_vals = []

        for emp in employees:
            emp_name = emp.name or ''
            dept_name = emp.department_id.name if emp.department_id else ''

            config_data = Config.get_config_for_employee(emp.id)
            config_rec = Config.get_config_record_for_employee(emp.id)
            working_days_list = config_data.get('working_days', [0, 1, 2, 3, 4, 5])
            grace_days = config_data.get('grace_late_days', 5)
            deduction_mode = config_data.get('deduction_mode', 'fixed')

            def calc_deduction_live(late_minutes, late_date, _config_rec=config_rec, _mode=deduction_mode, _emp=emp, _Slab=Slab):
                """Calculate deduction fresh at report time — never trust stale stored value."""
                import math
                if _mode == 'hourly':
                    if not _config_rec:
                        return 0.0
                    return _config_rec.get_hourly_deduction(_emp.id, late_minutes, late_date=late_date)
                else:
                    return _Slab.get_deduction_for_minutes(late_minutes, company_id=_emp.company_id.id)

            def calc_leave_deduction_live(leave_record, _emp=emp):
                """Calculate leave deduction live using salary-based formula — never trust stale stored value.

                Daily rate = wage ÷ working days in the month (the same
                `total_working_days` figure this report computes, half-day-Friday
                aware). This makes a full month of unpaid leave wipe the wage
                exactly, and keeps the report consistent with the absence rate.
                """
                if leave_record.unpaid_days <= 0:
                    return 0.0
                leave_cfg = self.env['hr.leave.config'].search(
                    [('company_id', '=', _emp.company_id.id)], limit=1
                )
                if not leave_cfg or not leave_cfg.unpaid_leave_deduction_enabled:
                    return 0.0
                try:
                    _wage = _emp.contract_wage or 0.0
                except Exception:
                    _wage = 0.0
                if _wage <= 0 or total_working_days <= 0:
                    return 0.0
                # Round the daily rate to currency precision FIRST, then per
                # record — so one day = wage/working-days rounded to 2dp (e.g.
                # 185.19) and N days = that × N (185.19×5 = 925.95). This matches
                # the leave request's stored deduction_amount exactly.
                daily_rate = round(_wage / total_working_days, 2)
                return round(leave_record.unpaid_days * daily_rate, 2)


            # ── Calculate working days in the month ──────────
            # A half-day Friday (Friday in a configured half-day position)
            # counts as 0.5 working day even when Friday itself is unchecked
            # as a working day. Full working days (the checked weekdays that
            # aren't holidays) count 1. The two branches are mutually
            # exclusive so a half-day Friday is never also counted as a full
            # day. Example: June with Friday off + positions "2,4,5" →
            # 26 full days + 0.5 + 0.5 = 27.
            total_working_days = 0.0
            half_fri_count = 0  # for the Calculation popup only
            current_date = d_from
            while current_date <= d_to:
                if Config.is_half_day_friday(current_date, emp.id):
                    total_working_days += 0.5
                    half_fri_count += 1
                elif current_date.weekday() in working_days_list:
                    if not Holiday.is_public_holiday(current_date, emp.company_id.id):
                        total_working_days += 1
                current_date += timedelta(days=1)

            # ── Get all attendance records for this employee ─
            all_attendance = self.env['hr.attendance'].search([
                ('employee_id', '=', emp.id),
                ('date', '>=', d_from),
                ('date', '<=', d_to),
            ], order='date asc, check_in asc')

            # Get dates the employee actually came to work
            present_dates = set()
            for att in all_attendance:
                if att.date:
                    present_dates.add(att.date)

            # Present on a half-day Friday counts 0.5 so the "Present Days"
            # figure stays consistent with the half-day-weighted working days.
            total_present_days = 0.0
            for _d in present_dates:
                total_present_days += 0.5 if Config.is_half_day_friday(_d, emp.id) else 1

            # ── LATE DATA (count TIMES not days) ────────────
            # Use late_sequence > 0 as the canonical "first late check-in of
            # session per day" filter — the same indicator hr_attendance_late
            # uses elsewhere now. Trust the per-record deduction_amount: it's
            # already computed by `_compute_deduction_amount` with proper
            # per-session grace counting (Session 1 and Session 2 each have
            # their own grace). Don't re-apply grace here, which used to mix
            # both sessions into a single counter and under-count.
            late_records = self.env['hr.attendance'].search([
                ('employee_id', '=', emp.id),
                ('is_late', '=', True),
                ('late_minutes', '>', 0),
                ('late_sequence', '>', 0),
                ('date', '>=', d_from),
                ('date', '<=', d_to),
            ], order='check_in asc')

            all_late_times = 0
            late_times_after_grace = 0
            total_late_minutes = 0
            total_late_deduction = 0.0
            late_dates_seen = set()
            late_date_info = {}  # date -> list of attendance records
            late_items = []  # for the Calculation popup only

            for att in late_records:
                all_late_times += 1
                if att.date not in late_date_info:
                    late_date_info[att.date] = []
                late_date_info[att.date].append(att)
                late_dates_seen.add(att.date)
                total_late_minutes += att.late_minutes
                # Recompute the deduction live — working days / deduction mode /
                # slabs may have changed since the stored value was computed, and
                # in Hourly mode the rate depends on working days. Apply grace +
                # waiver exactly like the detail lines so the summary total always
                # matches the day-wise breakdown (and a single Refresh suffices —
                # no separate "Recompute Late Records" step needed).
                if att.is_waived:
                    late_items.append({'date': att.date, 'minutes': att.late_minutes,
                                       'status': 'waived', 'amount': 0.0})
                    continue
                if att.late_sequence and att.late_sequence <= grace_days:
                    late_items.append({'date': att.date, 'minutes': att.late_minutes,
                                       'status': 'grace', 'amount': 0.0})
                    continue
                live_ded = calc_deduction_live(att.late_minutes, att.date)
                late_items.append({'date': att.date, 'minutes': att.late_minutes,
                                   'status': 'cut', 'amount': live_ded})
                if live_ded > 0:
                    late_times_after_grace += 1
                    total_late_deduction += live_ded

            # ── LEAVE DATA ───────────────────────────────────
            leave_records = self.env['hr.leave.request'].search([
                ('hr_employee_id', '=', emp.id),
                ('state', '=', 'approved'),
                ('from_date', '>=', str(d_from)),
                ('from_date', '<=', str(d_to)),
            ], order='from_date asc')

            # Leave Policy changes (e.g. unchecking Paid Leave) are NOT
            # dependencies of `_compute_paid_status`, so the stored
            # paid_days/unpaid_days can be stale. Force a fresh recompute so
            # the report always reflects the current policy — same
            # "never trust stale stored value" stance used for late deductions.
            if leave_records:
                leave_records._compute_paid_status()

            total_paid_days = 0.0
            total_unpaid_days = 0.0
            total_leave_deduction = 0.0
            total_leave_only_ded = 0.0  # unpaid-LEAVE deductions only (no absence)
            leave_date_info = {}  # date -> leave record

            type_labels = dict(
                self.env['hr.leave.request']._fields['leave_type'].selection
            )

            leave_items = []  # for the Calculation popup only

            for lr in leave_records:
                total_paid_days += lr.paid_days
                total_unpaid_days += lr.unpaid_days
                _lr_ded = calc_leave_deduction_live(lr)
                total_leave_deduction += _lr_ded
                total_leave_only_ded += _lr_ded  # leave-request deductions only
                leave_items.append({
                    'label': type_labels.get(lr.leave_type, lr.leave_type) or 'Leave',
                    'from': lr.from_date,
                    'to': lr.to_date or lr.from_date,
                    'paid': lr.paid_days,
                    'unpaid': lr.unpaid_days,
                    'amount': _lr_ded,
                })

                # Map leave to each day it covers
                lr_start = lr.from_date
                lr_end = lr.to_date or lr.from_date
                lr_current = lr_start
                while lr_current <= lr_end:
                    if d_from <= lr_current <= d_to:
                        leave_date_info[lr_current] = lr
                    lr_current += timedelta(days=1)

            # Leave days worth a warning in the Calculation popup: leave on a day
            # the employee also came, or on a day off (leave requests count
            # calendar days, so a day off inside a leave is still counted).
            leave_on_work_dates = sorted(dd for dd in leave_date_info if dd in present_dates)
            leave_on_off_dates = sorted(
                dd for dd in leave_date_info
                if dd not in present_dates and (
                    Holiday.is_public_holiday(dd, emp.company_id.id)
                    or (dd.weekday() not in working_days_list
                        and not Config.is_half_day_friday(dd, emp.id))
                )
            )

            # ── AUTO HALF-DAY DETECTION (split shift only) ───
            # For each working day, check if only one session has attendance
            # S1 present + S2 absent = auto half-day PM
            # S2 present + S1 absent = auto half-day AM
            auto_half_day_info = {}  # date -> {'session': 'am'|'pm', 'label': str, 'reason': str, 'deduction': float}
            shift_type = config_data.get('shift_type', 'single')
            if shift_type == 'split':
                session1_end = config_data.get('office_end_hour', 14.0)
                import pytz as _pytz
                # Office Timezone (config) wins, like the late computes.
                _tz = _pytz.timezone(config_data.get('timezone') or emp.tz or 'UTC')
                # Group attendance by date and session
                att_by_date = {}
                for att in all_attendance:
                    if not att.date or not att.check_in:
                        continue
                    _local = _pytz.utc.localize(att.check_in).astimezone(_tz)
                    _hour = _local.hour + _local.minute / 60.0
                    _sess = 'S1' if _hour < session1_end else 'S2'
                    if att.date not in att_by_date:
                        att_by_date[att.date] = set()
                    att_by_date[att.date].add(_sess)

                # Calculate leave deduction rate for auto half-day
                _leave_config = self.env['hr.leave.config'].search(
                    [('company_id', '=', emp.company_id.id)], limit=1
                )
                def _half_day_deduction(check_date):
                    if not _leave_config or not _leave_config.unpaid_leave_deduction_enabled:
                        return 0.0
                    try:
                        _wage = emp.contract_wage or 0.0
                    except Exception:
                        _wage = 0.0
                    if _wage > 0 and total_working_days > 0:
                        return round(round(_wage / total_working_days, 2) / 2.0, 2)
                    return 0.0

                # Today's date in the employee's timezone (the day-in-progress
                # mustn't be auto-half-flagged — Session 2 may still be ahead).
                today_local = _pytz.utc.localize(
                    fields.Datetime.now()
                ).astimezone(_tz).date()

                # Earliest attendance date for this employee — anything before
                # this is "pre-hire" and should never count as auto half-day.
                first_att_date = None
                for _att in all_attendance:
                    if _att.date and (first_att_date is None or _att.date < first_att_date):
                        first_att_date = _att.date

                for _date, _sessions in att_by_date.items():
                    # Skip today (day in progress) and any date before this
                    # employee's first check-in (they hadn't joined yet).
                    if _date >= today_local:
                        continue
                    if first_att_date and _date < first_att_date:
                        continue
                    if _date in leave_date_info:  # don't override explicit leave requests
                        continue
                    if 'S1' in _sessions and 'S2' not in _sessions:
                        # Morning only → missed afternoon session
                        auto_half_day_info[_date] = {
                            'session': 'pm',
                            'label': 'Half Day - Afternoon Absent',
                            'reason': 'Auto-detected: No check-in for afternoon session',
                            'deduction': _half_day_deduction(_date),
                        }
                    elif 'S2' in _sessions and 'S1' not in _sessions:
                        # Afternoon only → missed morning session
                        auto_half_day_info[_date] = {
                            'session': 'am',
                            'label': 'Half Day - Morning Absent',
                            'reason': 'Auto-detected: No check-in for morning session',
                            'deduction': _half_day_deduction(_date),
                        }

                # Add auto half-day deductions to leave totals
                for _date, _info in auto_half_day_info.items():
                    total_unpaid_days += 0.5
                    total_leave_deduction += _info['deduction']

            # ── BUILD DAY-WISE DETAIL LINES ──────────────────
            # Today (user timezone) — days after this haven't happened yet, so a
            # working day with no data is "not arrived", not absent/not-entered.
            report_today = fields.Date.context_today(self)
            # Office timezone for displaying check-in/out (config → employee → UTC),
            # so the report reads the same office time for everyone.
            import pytz as _pytz
            report_tz = _pytz.timezone(config_data.get('timezone') or emp.tz or 'UTC')

            def _office_time(dt):
                return _pytz.utc.localize(dt).astimezone(report_tz).strftime('%I:%M %p') if dt else ''

            current_date = d_from
            day_seq = 0
            # Working days with no attendance and no leave, for the Calculation
            # popup: already passed vs still to come this month.
            absent_past_days = 0.0
            absent_future_days = 0.0
            while current_date <= d_to:
                is_working = current_date.weekday() in working_days_list
                is_holiday = Holiday.is_public_holiday(current_date, emp.company_id.id)
                is_half_day_fri = Config.is_half_day_friday(current_date, emp.id)
                # A half-day Friday is an expected (half) working day even though
                # Friday itself is unchecked, so it must be treated as absent when
                # nobody checks in — otherwise it would be silently dropped.
                is_expected = is_working or is_half_day_fri

                # Determine what happened on this day
                has_leave = current_date in leave_date_info
                has_late = current_date in late_date_info
                is_present = current_date in present_dates

                # Skip non-working days (weekends) unless they have data
                if not is_expected and not is_holiday and not has_leave and not is_present:
                    current_date += timedelta(days=1)
                    continue

                day_seq += 1

                # Determine day type
                if is_holiday:
                    day_type = 'holiday'
                    holiday_rec = Holiday.search([
                        ('date', '=', current_date),
                        ('company_id', '=', emp.company_id.id),
                    ], limit=1)
                    description = f"Holiday: {holiday_rec.name}" if holiday_rec else 'Public Holiday'
                    detail_vals.append({
                        'report_id': self.id,
                        'employee_id': emp.id,
                        'employee_name': emp_name,
                        'department_name': dept_name,
                        'entry_date': current_date,
                        'day_type': 'holiday',
                        'description': description,
                        'check_in_time': '',
                        'late_minutes': 0,
                        'late_minutes_display': '',
                        'late_reason': '',
                        'leave_type': False,
                        'leave_paid_type': '',
                        'leave_reason': '',
                        'late_deduction': 0,
                        'leave_deduction': 0,
                        'is_half_day': False,
                    })
                elif has_leave:
                    lr = leave_date_info[current_date]
                    leave_label = type_labels.get(lr.leave_type, lr.leave_type)
                    paid_type = 'Paid' if lr.is_paid else ('Unpaid' if lr.unpaid_days > 0 and lr.paid_days == 0 else 'Partial')

                    # If employee also came late on this leave day, show first late
                    check_in_str = ''
                    check_out_str = ''
                    late_min = 0
                    late_min_disp = ''
                    late_reas = ''
                    late_ded = 0.0
                    if has_late:
                        att = late_date_info[current_date][0]  # first late of the day
                        check_in_str = _office_time(att.check_in)
                        check_out_str = _office_time(att.check_out)
                        late_min = att.late_minutes
                        late_min_disp = minutes_to_hm(att.late_minutes)
                        late_reas = att.late_reason or ''
                        if att.is_waived:
                            late_ded = 0.0
                        else:
                            late_ded = calc_deduction_live(att.late_minutes, att.date)

                    detail_vals.append({
                        'report_id': self.id,
                        'employee_id': emp.id,
                        'employee_name': emp_name,
                        'department_name': dept_name,
                        'entry_date': current_date,
                        'day_type': 'leave',
                        'description': f"{leave_label}" + (" (Half Day)" if lr.is_half_day else ""),
                        'check_in_time': check_in_str,
                        'check_out_time': check_out_str,
                        'late_minutes': late_min,
                        'late_minutes_display': late_min_disp,
                        'late_reason': late_reas,
                        'leave_type': lr.leave_type,
                        'leave_paid_type': paid_type,
                        'leave_reason': lr.reason or '',
                        'late_deduction': late_ded,
                        'leave_deduction': calc_leave_deduction_live(lr) if current_date == lr.from_date else 0,
                        'is_half_day': lr.is_half_day or is_half_day_fri,
                    })
                elif has_late:
                    # Create one detail line per late occurrence on this day
                    late_atts = late_date_info[current_date]
                    for att in late_atts:
                        check_in_str = _office_time(att.check_in)
                        check_out_str = _office_time(att.check_out)
                        is_waived = att.is_waived
                        effective_deduction = 0.0 if is_waived else calc_deduction_live(att.late_minutes, att.date)

                        session_label = f" S{att.checkin_session}" if att.checkin_session else ""
                        seq_label = f"#{att.late_sequence}" if att.late_sequence else ""

                        desc_parts = [f"Late ({seq_label}{session_label})"]
                        if att.late_sequence and att.late_sequence <= grace_days:
                            desc_parts.append('[Grace]')
                            effective_deduction = 0.0
                        if is_waived:
                            desc_parts.append('[Waived]')

                        detail_vals.append({
                            'report_id': self.id,
                            'employee_id': emp.id,
                            'employee_name': emp_name,
                            'department_name': dept_name,
                            'entry_date': current_date,
                            'day_type': 'late',
                            'description': ' '.join(desc_parts),
                            'check_in_time': check_in_str,
                            'check_out_time': check_out_str,
                            'late_minutes': att.late_minutes,
                            'late_minutes_display': minutes_to_hm(att.late_minutes),
                            'late_reason': att.late_reason or '',
                            'leave_type': False,
                            'leave_paid_type': 'Waived' if is_waived else '',
                            'leave_reason': att.waiver_reason or '' if is_waived else '',
                            'late_deduction': effective_deduction,
                            'leave_deduction': 0,
                            'is_half_day': is_half_day_fri,
                        })
                elif is_present:
                    # Normal present day — find first check-in
                    first_att = None
                    for att in all_attendance:
                        if att.date == current_date and att.is_first_checkin_of_day:
                            first_att = att
                            break
                    check_in_str = _office_time(first_att.check_in) if first_att else ''
                    check_out_str = _office_time(first_att.check_out) if first_att else ''

                    # Check if this is an auto-detected half day (split shift missing one session)
                    auto_hd = auto_half_day_info.get(current_date)
                    is_auto_half = auto_hd is not None
                    auto_hd_label = auto_hd['label'] if auto_hd else ''
                    auto_hd_ded = auto_hd['deduction'] if auto_hd else 0.0
                    auto_hd_reason = auto_hd['reason'] if auto_hd else ''

                    detail_vals.append({
                        'report_id': self.id,
                        'employee_id': emp.id,
                        'employee_name': emp_name,
                        'department_name': dept_name,
                        'entry_date': current_date,
                        'day_type': 'present',
                        'description': (auto_hd_label if is_auto_half else 'Present') +
                                       (' (Half Day)' if is_half_day_fri else ''),
                        'check_in_time': check_in_str,
                        'check_out_time': check_out_str,
                        'late_minutes': 0,
                        'late_minutes_display': '',
                        'late_reason': '',
                        'leave_type': False,
                        'leave_paid_type': 'Unpaid' if is_auto_half and auto_hd_ded > 0 else '',
                        'leave_reason': auto_hd_reason,
                        'late_deduction': 0,
                        'leave_deduction': auto_hd_ded,
                        'is_half_day': is_half_day_fri or is_auto_half,
                    })
                elif is_expected and not is_holiday:
                    # Expected working day with no attendance and no leave.
                    # Future days haven't arrived yet → don't show them at all.
                    if current_date > report_today:
                        absent_future_days += 0.5 if is_half_day_fri else 1
                        current_date += timedelta(days=1)
                        continue
                    absent_past_days += 0.5 if is_half_day_fri else 1
                    # Past/today working day with nothing entered → "Not Entered"
                    # (data-entry pending). In the earnings model it simply isn't
                    # earned, so it's already reflected in Final / Total Deduction;
                    # the "Leave Deduction" column stays for leave requests only.
                    detail_vals.append({
                        'report_id': self.id,
                        'employee_id': emp.id,
                        'employee_name': emp_name,
                        'department_name': dept_name,
                        'entry_date': current_date,
                        'day_type': 'absent',
                        'description': 'Not Entered' + (' (Half Day)' if is_half_day_fri else ''),
                        'check_in_time': '',
                        'late_minutes': 0,
                        'late_minutes_display': '',
                        'late_reason': '',
                        'leave_type': False,
                        'leave_paid_type': '',
                        'leave_reason': '',
                        'late_deduction': 0,
                        'leave_deduction': 0,
                        'is_half_day': is_half_day_fri,
                    })

                current_date += timedelta(days=1)

            # ── WAGE ─────────────────────────────────────────
            emp_wage = 0.0
            try:
                emp_wage = emp.contract_wage or 0.0
            except Exception:
                emp_wage = 0.0

            # ── EARNINGS-BASED FINAL AMOUNT ──────────────────
            # Final = pay actually earned − late deductions. The employee earns
            # one day's wage (wage ÷ working days) for every day worked: present
            # days (half-day-Friday weighted) plus any PAID leave. Absent days and
            # unpaid leave are simply not earned; split-shift auto half-days (only
            # one session worked) earn half. Late arrivals reduce the earned pay.
            #   1 present day on a 5000/27 wage → 185.19 earned − late → Final.
            # Daily rate is rounded to currency precision (185.19) and used for
            # every multiple, so report figures match a manual 185.19×N calc and
            # the leave-request deductions exactly.
            daily_rate = round(emp_wage / total_working_days, 2) if total_working_days > 0 else 0.0
            auto_half_count = len(auto_half_day_info)
            earned_days = max(0.0, total_present_days + total_paid_days - 0.5 * auto_half_count)
            earned = round(daily_rate * earned_days, 2)
            # Rounding the rate up can make a full month's earnings exceed the wage
            # by a few paise — cap so 100% attendance pays exactly the wage.
            if earned > emp_wage:
                earned = emp_wage
            final_amt = round(max(0.0, earned - total_late_deduction), 2)
            # Show the unpaid-LEAVE deduction on its own column. Total Deduction is
            # then everything else not received (absent days + late). So the three
            # reconcile to the wage:  Total Deduction + Leave Deduction + Final = Wage.
            leave_ded = round(total_leave_only_ded, 2)
            total_ded = round(max(0.0, emp_wage - final_amt - leave_ded), 2)

            # Hourly late-cut rate, same formula as get_hourly_deduction(), so the
            # Calculation popup can show "7 hours × 1.139".
            hourly_info = None
            if deduction_mode == 'hourly' and config_rec and config_rec.daily_work_hours > 0:
                ded_wage = 0.0
                for fname in ('contract_wage', 'wage'):
                    try:
                        v = getattr(emp, fname, 0.0) or 0.0
                    except Exception:
                        v = 0.0
                    if v > 0:
                        ded_wage = v
                        break
                month_wd = config_rec.get_working_days_in_month(
                    d_from.year, d_from.month, emp.company_id.id)
                if ded_wage > 0 and month_wd > 0:
                    hourly_info = {
                        'wage': ded_wage,
                        'working_days': month_wd,
                        'hours': config_rec.daily_work_hours,
                        'rate': ded_wage / month_wd / config_rec.daily_work_hours,
                    }

            calculation_html = self._build_calculation_html({
                'currency': self.currency_id,
                'wage': emp_wage,
                'working_days': total_working_days,
                'half_fri_count': half_fri_count,
                'daily_rate': daily_rate,
                'present_days': total_present_days,
                'auto_half': sorted(auto_half_day_info.items()),
                'leaves': leave_items,
                'leave_on_work_dates': leave_on_work_dates,
                'leave_on_off_dates': leave_on_off_dates,
                'paid_leave_days': total_paid_days,
                'absent_past': absent_past_days,
                'absent_future': absent_future_days,
                'earned_days': earned_days,
                'earned_uncapped': round(daily_rate * earned_days, 2),
                'earned': earned,
                'late_items': late_items,
                'grace_days': grace_days,
                'hourly': hourly_info,
                'late_total': round(total_late_deduction, 2),
                'final': final_amt,
                'leave_ded': leave_ded,
                'total_ded': total_ded,
            })

            summary_vals.append({
                'report_id': self.id,
                'employee_id': emp.id,
                'employee_name': emp_name,
                'department_name': dept_name,
                'total_working_days': total_working_days,
                'total_present_days': total_present_days,
                'total_late_days_raw': all_late_times,
                'grace_days': grace_days,
                'late_days': late_times_after_grace,
                'late_minutes': total_late_minutes,
                'late_minutes_display': minutes_to_hm(total_late_minutes),
                'late_deduction': round(total_late_deduction, 2),
                'paid_leave_days': total_paid_days,
                'unpaid_leave_days': total_unpaid_days,
                'leave_deduction': leave_ded,
                'wage': emp_wage,
                'total_deduction': total_ded,
                'final_amount': final_amt,
                'calculation_html': calculation_html,
            })

        # Batch create
        if summary_vals:
            self.env['hr.employee.report.summary.line'].create(summary_vals)
        if detail_vals:
            self.env['hr.employee.report.detail.line'].create(detail_vals)

    # ── Calculation popup ────────────────────────────────────
    def _build_calculation_html(self, d):
        """Explain one employee's Final / Leave Deduction / Total Deduction in
        plain words for the 🧮 Calculation popup.

        Built from the exact figures _generate_data just used, so the popup
        always matches the row it belongs to.
        """
        cur = d['currency']
        dp = cur.decimal_places if cur else 2

        def amt(v):
            return f"{v:,.{dp}f}"

        def num(v):
            return f"{round(v, 2):g}"

        def days(v):
            return f"{num(v)} day" if round(v, 2) == 1 else f"{num(v)} days"

        def day_str(dd):
            return f"{dd.day} {dd.strftime('%b')}"

        def range_str(a, b):
            if not b or a == b:
                return day_str(a)
            if a.month == b.month:
                return f"{a.day}–{b.day} {b.strftime('%b')}"
            return f"{day_str(a)} – {day_str(b)}"

        def late_str(minutes):
            h, m = divmod(int(minutes or 0), 60)
            parts = []
            if h:
                parts.append(f"{h} hr" if h == 1 else f"{h} hrs")
            if m or not h:
                parts.append(f"{m} min")
            return ' '.join(parts)

        def bold(text):
            return Markup('<b>{}</b>').format(text)

        def sub(text):
            return Markup('<span class="ps-3 text-muted">• {}</span>').format(text)

        def block(title, lines):
            body = Markup('').join(Markup('<div>{}</div>').format(ln) for ln in lines)
            return Markup('<div class="mb-3"><div class="fw-bold fs-6 mb-1">{}</div>'
                          '<div class="ps-3">{}</div></div>').format(title, body)

        wage = d['wage']
        rate = d['daily_rate']

        if wage <= 0 or d['working_days'] <= 0:
            return Markup('<p>No monthly salary is set for this employee, '
                          'so everything is 0.</p>')

        out = []

        # One day's salary
        out.append(block("One day's salary", [
            f"Monthly salary = {amt(wage)}",
            f"Working days = {num(d['working_days'])}",
            bold(f"One day's salary = {amt(wage)} ÷ {num(d['working_days'])} = {amt(rate)}"),
        ]))

        # Days paid
        lines = [f"Came to work = {days(d['present_days'])}"
                 + (" → paid" if d['present_days'] else "")]
        for hd_date, info in d['auto_half']:
            which = 'evening' if info.get('session') == 'am' else 'morning'
            lines.append(sub(f"{day_str(hd_date)} – came only in the {which} → half day paid"))

        unpaid_leave_days = 0.0
        for lv in d['leaves']:
            total_lv = lv['paid'] + lv['unpaid']
            if lv['unpaid'] <= 0:
                split = 'paid'
            elif lv['paid'] <= 0:
                split = 'not paid'
            else:
                split = f"{days(lv['paid'])} paid, {days(lv['unpaid'])} not paid"
            label = lv['label'] if 'leave' in lv['label'].lower() else f"{lv['label']} leave"
            lines.append(f"{label} {range_str(lv['from'], lv['to'])} = "
                         f"{days(total_lv)} → {split}")
            unpaid_leave_days += lv['unpaid']

        absent = d['absent_past'] + d['absent_future']
        if absent:
            lines.append(f"Did not come = {days(absent)} → not paid")
            fut = d['absent_future']
            if fut:
                lines.append(sub(f"{num(fut)} of these days "
                                 f"{'is' if round(fut, 2) == 1 else 'are'} still to come"))

        lines.append(bold(f"Days paid = {days(d['earned_days'])}"))
        lines.append(bold(f"Salary for days paid = {num(d['earned_days'])} × {amt(rate)} = "
                          f"{amt(d['earned_uncapped'])}"))
        if d['earned'] < d['earned_uncapped']:
            lines.append(f"This is more than the monthly salary, so it is {amt(d['earned'])}.")
        out.append(block("Days paid", lines))

        # Late
        late_items = d['late_items']
        hourly = d['hourly']
        if late_items:
            cuts = [li for li in late_items if li['status'] == 'cut' and li['amount'] > 0]
            one_hourly_cut = bool(hourly) and len(cuts) == 1
            lines = []
            if hourly and cuts:
                lines.append(f"One hour's salary = {hourly['rate']:.3f}")
            for li in late_items:
                head = f"{day_str(li['date'])} – late {late_str(li['minutes'])}"
                if li['status'] == 'grace':
                    lines.append(f"{head} → no cut (first {d['grace_days']} lates are free)")
                elif li['status'] == 'waived':
                    lines.append(f"{head} → no cut (excused)")
                elif li['amount'] <= 0:
                    lines.append(f"{head} → no cut")
                elif hourly:
                    hrs = math.ceil(li['minutes'] / 60.0)
                    counted = f"{head} → counted as {hrs} {'hour' if hrs == 1 else 'hours'}"
                    lines.append(counted if one_hourly_cut
                                 else f"{counted} → cut {amt(li['amount'])}")
                else:
                    lines.append(f"{head} → cut {amt(li['amount'])}")
            if one_hourly_cut:
                hrs = math.ceil(cuts[0]['minutes'] / 60.0)
                lines.append(bold(f"Late cut = {hrs} × {hourly['rate']:.3f} = "
                                  f"{amt(d['late_total'])}"))
            else:
                total_word = 'Late cut total' if len(cuts) > 1 else 'Late cut'
                lines.append(bold(f"{total_word} = {amt(d['late_total'])}"))
            out.append(block("Late", lines))

        # Final salary
        if d['late_total'] > 0:
            final_text = (f"FINAL SALARY = {amt(d['earned'])} − {amt(d['late_total'])} "
                          f"= {amt(d['final'])}")
        else:
            final_text = f"FINAL SALARY = {amt(d['final'])}"
        out.append(Markup('<div class="alert alert-success fs-5 fw-bold mb-3">{}</div>')
                   .format(final_text))
        if d['earned'] - d['late_total'] < 0:
            out.append(Markup('<div class="text-muted mb-3">{}</div>').format(
                "The late cut is more than the salary for days paid, so the final salary is 0."))

        # Good to know
        late_applied = round(d['earned'] - d['final'], 2)
        not_paid_amt = max(0.0, round(d['total_ded'] - late_applied, 2))
        notes = []
        if d['leave_ded']:
            unit = 'day' if round(unpaid_leave_days, 2) == 1 else 'days'
            notes.append(f"Leave Deduction ({amt(d['leave_ded'])}) = "
                         f"{num(unpaid_leave_days)} unpaid {unit} × {amt(rate)}. "
                         f"It is NOT cut again from the final salary.")
        td = f"Total Deduction ({amt(d['total_ded'])}) = salary for days not paid ({amt(not_paid_amt)})"
        if late_applied:
            td += f" + late cut ({amt(late_applied)})"
        notes.append(td + ". It is NOT an extra cut.")
        for dd in d['leave_on_work_dates']:
            notes.append(f"⚠ {day_str(dd)} – came to work and also has leave on the same "
                         f"day. Please check.")
        for dd in d['leave_on_off_dates']:
            notes.append(f"⚠ {day_str(dd)} ({dd.strftime('%A')}) – this is a day off, but "
                         f"the leave on it is still counted. Please check.")
        check_sum = d['final'] + d['leave_ded'] + d['total_ded']
        notes.append(f"Check: {amt(d['final'])} + {amt(d['leave_ded'])} + "
                     f"{amt(d['total_ded'])} = {amt(check_sum)}"
                     + (" ✓" if abs(check_sum - wage) < 0.005 else ""))

        out.append(Markup('<div class="alert alert-info mb-0"><b>Good to know</b>'
                          '<ul class="mb-0 mt-1">{}</ul></div>').format(
            Markup('').join(Markup('<li>{}</li>').format(n) for n in notes)))

        return Markup('<div class="o_emp_calc">{}</div>').format(Markup('').join(out))

    # ── PDF Export ────────────────────────────────────────────
    def action_print_pdf(self):
        return self.env.ref(
            'hr_employee_report.action_report_employee_pdf'
        ).report_action(self)

    # ── Excel Export ─────────────────────────────────────────
    def action_export_excel(self):
        self.ensure_one()
        try:
            import xlsxwriter
        except ImportError:
            raise exceptions.UserError(
                'xlsxwriter is required for Excel export. '
                'Install it with: pip install xlsxwriter'
            )

        output = io.BytesIO()
        wb = xlsxwriter.Workbook(output, {'in_memory': True})

        # ── Styles ───────────────────────────────────────────
        title_fmt = wb.add_format({
            'bold': True, 'font_size': 16, 'align': 'left',
        })
        header_fmt = wb.add_format({
            'bold': True, 'font_size': 10, 'bg_color': '#875A7B',
            'font_color': 'white', 'border': 1, 'align': 'center',
            'valign': 'vcenter', 'text_wrap': True,
        })
        cell_fmt = wb.add_format({
            'font_size': 10, 'border': 1, 'align': 'left',
            'valign': 'vcenter',
        })
        num_fmt = wb.add_format({
            'font_size': 10, 'border': 1, 'align': 'right',
            'valign': 'vcenter', 'num_format': '#,##0.00',
        })
        int_fmt = wb.add_format({
            'font_size': 10, 'border': 1, 'align': 'center',
            'valign': 'vcenter',
        })
        total_label_fmt = wb.add_format({
            'bold': True, 'font_size': 10, 'border': 1,
            'align': 'right', 'bg_color': '#F2F2F2',
        })
        total_num_fmt = wb.add_format({
            'bold': True, 'font_size': 10, 'border': 1,
            'align': 'right', 'bg_color': '#F2F2F2',
            'num_format': '#,##0.00',
        })
        total_int_fmt = wb.add_format({
            'bold': True, 'font_size': 10, 'border': 1,
            'align': 'center', 'bg_color': '#F2F2F2',
        })
        info_label = wb.add_format({'bold': True, 'font_size': 10})
        info_value = wb.add_format({'font_size': 10})

        month_names = dict(self._fields['month'].selection)

        # ═══════════════════════════════════════════════════
        #  SHEET 1: Employee Summary
        # ═══════════════════════════════════════════════════
        ws1 = wb.add_worksheet('Employee Summary')
        ws1.set_landscape()
        ws1.set_paper(9)

        ws1.merge_range('A1:M1', 'Employee Statement Report', title_fmt)
        ws1.write('A3', 'Company:', info_label)
        ws1.write('B3', self.company_id.name or '', info_value)
        ws1.write('A4', 'Period:', info_label)
        ws1.write('B4', f"{month_names.get(self.month, '')} {self.year}", info_value)

        row = 6
        summary_headers = [
            'Employee', 'Department', 'Working\nDays', 'Present\nDays',
            'Late Days\n(After Grace)', 'Total Late\nTime',
            'Late\nDeduction', 'Paid Leave\nDays', 'Unpaid Leave\nDays',
            'Leave\nDeduction', 'Monthly\nWage', 'Total\nDeduction', 'Final\nAmount',
        ]
        col_widths = [25, 20, 10, 10, 12, 12, 14, 12, 12, 14, 14, 14, 14]
        for c, (hdr, w) in enumerate(zip(summary_headers, col_widths)):
            ws1.set_column(c, c, w)
            ws1.write(row, c, hdr, header_fmt)

        row += 1
        for line in self.summary_line_ids:
            ws1.write(row, 0, line.employee_name or '', cell_fmt)
            ws1.write(row, 1, line.department_name or '', cell_fmt)
            ws1.write(row, 2, line.total_working_days, int_fmt)
            ws1.write(row, 3, line.total_present_days, int_fmt)
            ws1.write(row, 4, line.late_days, int_fmt)
            ws1.write(row, 5, line.late_minutes_display or '0:00', cell_fmt)
            ws1.write(row, 6, line.late_deduction, num_fmt)
            ws1.write(row, 7, line.paid_leave_days, num_fmt)
            ws1.write(row, 8, line.unpaid_leave_days, num_fmt)
            ws1.write(row, 9, line.leave_deduction, num_fmt)
            ws1.write(row, 10, line.wage, num_fmt)
            ws1.write(row, 11, line.total_deduction, num_fmt)
            ws1.write(row, 12, line.final_amount, num_fmt)
            row += 1

        # Totals row
        ws1.merge_range(row, 0, row, 1, 'Grand Total', total_label_fmt)
        ws1.write(row, 2, sum(self.summary_line_ids.mapped('total_working_days')), total_int_fmt)
        ws1.write(row, 3, sum(self.summary_line_ids.mapped('total_present_days')), total_int_fmt)
        ws1.write(row, 4, sum(self.summary_line_ids.mapped('late_days')), total_int_fmt)
        ws1.write(row, 5, '', total_int_fmt)
        ws1.write(row, 6, self.grand_late_deduction, total_num_fmt)
        ws1.write(row, 7, sum(self.summary_line_ids.mapped('paid_leave_days')), total_num_fmt)
        ws1.write(row, 8, sum(self.summary_line_ids.mapped('unpaid_leave_days')), total_num_fmt)
        ws1.write(row, 9, self.grand_leave_deduction, total_num_fmt)
        ws1.write(row, 10, self.grand_wage, total_num_fmt)
        ws1.write(row, 11, self.grand_total_deduction, total_num_fmt)
        ws1.write(row, 12, self.grand_final_amount, total_num_fmt)

        # ═══════════════════════════════════════════════════
        #  SHEET 2: Detailed Day-wise Entries
        # ═══════════════════════════════════════════════════
        ws2 = wb.add_worksheet('Detailed Entries')
        ws2.set_landscape()
        ws2.set_paper(9)

        ws2.merge_range('A1:N1', 'Detailed Day-wise Entries', title_fmt)
        ws2.write('A3', 'Period:', info_label)
        ws2.write('B3', f"{month_names.get(self.month, '')} {self.year}", info_value)

        row = 4
        detail_headers = [
            'Date', 'Employee', 'Department', 'Day Type', 'Description',
            'Check In', 'Check Out', 'Late Time', 'Late Reason',
            'Leave Type', 'Leave (Paid/Unpaid)', 'Leave Reason',
            'Late Ded.', 'Leave Ded.',
        ]
        detail_widths = [12, 22, 18, 10, 25, 12, 12, 10, 20, 12, 14, 20, 12, 12]
        for c, (hdr, w) in enumerate(zip(detail_headers, detail_widths)):
            ws2.set_column(c, c, w)
            ws2.write(row, c, hdr, header_fmt)

        row += 1
        sorted_details = self.detail_line_ids.sorted(
            key=lambda r: (r.employee_name or '', r.entry_date)
        )
        for dl in sorted_details:
            ws2.write(row, 0, str(dl.entry_date) if dl.entry_date else '', cell_fmt)
            ws2.write(row, 1, dl.employee_name or '', cell_fmt)
            ws2.write(row, 2, dl.department_name or '', cell_fmt)
            ws2.write(row, 3, dict(dl._fields['day_type'].selection).get(dl.day_type, ''), cell_fmt)
            ws2.write(row, 4, dl.description or '', cell_fmt)
            ws2.write(row, 5, dl.check_in_time or '', cell_fmt)
            ws2.write(row, 6, dl.check_out_time or '', cell_fmt)
            ws2.write(row, 7, dl.late_minutes_display or '', cell_fmt)
            ws2.write(row, 8, dl.late_reason or '', cell_fmt)
            leave_label = dict(self.env['hr.leave.request']._fields['leave_type'].selection).get(dl.leave_type, '') if dl.leave_type else ''
            ws2.write(row, 9, leave_label, cell_fmt)
            ws2.write(row, 10, dl.leave_paid_type or '', cell_fmt)
            ws2.write(row, 11, dl.leave_reason or '', cell_fmt)
            ws2.write(row, 12, dl.late_deduction, num_fmt)
            ws2.write(row, 13, dl.leave_deduction, num_fmt)
            row += 1

        # Totals
        ws2.merge_range(row, 0, row, 11, 'Grand Total Deductions', total_label_fmt)
        ws2.write(row, 12, sum(self.detail_line_ids.mapped('late_deduction')), total_num_fmt)
        ws2.write(row, 13, sum(self.detail_line_ids.mapped('leave_deduction')), total_num_fmt)

        wb.close()

        file_name = f"Employee_Report_{month_names.get(self.month, '')}_{self.year}.xlsx"
        attachment = self.env['ir.attachment'].sudo().create({
            'name': file_name,
            'type': 'binary',
            'datas': base64.b64encode(output.getvalue()),
            'mimetype': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
        output.close()

        return {
            'type': 'ir.actions.act_url',
            'url': f'/web/content/{attachment.id}?download=true',
            'target': 'new',
        }


# ──────────────────────────────────────────────────────────────
#  SUMMARY LINE – one row per employee
# ──────────────────────────────────────────────────────────────
class EmployeeReportSummaryLine(models.Model):
    _name = 'hr.employee.report.summary.line'
    _description = 'Employee Report Summary Line'
    _order = 'employee_name asc'

    @api.model
    def _auto_init(self):
        cr = self.env.cr
        cr.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = %s AND column_name IN %s AND data_type = 'jsonb'
        """, (self._table, ('employee_name', 'department_name')))
        for (col,) in cr.fetchall():
            _logger.info('Fixing column type: %s.%s from jsonb to varchar', self._table, col)
            cr.execute(
                'ALTER TABLE "' + self._table + '" DROP COLUMN "' + col + '"'
            )
        return super()._auto_init()

    report_id = fields.Many2one(
        'hr.employee.report', string='Report',
        required=True, ondelete='cascade', index=True,
    )
    currency_id = fields.Many2one(
        'res.currency', related='report_id.company_id.currency_id', readonly=True,
    )
    employee_id = fields.Many2one('hr.employee', string='Employee', readonly=True)
    employee_name = fields.Char(string='Employee', readonly=True)
    department_name = fields.Char(string='Department', readonly=True)

    # Attendance (Float — half-day Fridays count as 0.5)
    total_working_days = fields.Float(string='Working Days', readonly=True)
    total_present_days = fields.Float(string='Present Days', readonly=True)

    # Late tracking
    late_days = fields.Integer(string='Late Days (After Grace)', readonly=True)
    total_late_days_raw = fields.Integer(string='Total Late Days (Raw)', readonly=True)
    grace_days = fields.Integer(string='Grace Days', readonly=True)
    late_minutes = fields.Integer(string='Total Late (Min)', readonly=True)
    late_minutes_display = fields.Char(string='Total Late Time', readonly=True)
    late_deduction = fields.Float(string='Late Deduction', readonly=True)

    # Leave tracking
    paid_leave_days = fields.Float(string='Paid Leave Days', readonly=True)
    unpaid_leave_days = fields.Float(string='Unpaid Leave Days', readonly=True)
    leave_deduction = fields.Float(string='Leave Deduction', readonly=True)

    # Wage & Final
    wage = fields.Float(string='Wage', readonly=True)
    total_deduction = fields.Float(string='Total Deduction', readonly=True)
    final_amount = fields.Float(string='Final Amount', readonly=True)

    # Plain-words breakdown of the figures above, built by _generate_data
    calculation_html = fields.Html(string='Calculation', readonly=True, sanitize=False)

    # ── Drill-down Actions ───────────────────────────────────
    def action_view_calculation(self):
        """Open the plain-words salary breakdown for this employee in a popup."""
        self.ensure_one()
        if not self.calculation_html:
            raise exceptions.UserError(
                "This report was made before the Calculation button was added. "
                "Click ⟳ Refresh on the report to build the calculation."
            )
        view_id = self.env.ref('hr_employee_report.view_summary_line_calculation_form').id
        return {
            'name': f'Calculation – {self.employee_name}',
            'type': 'ir.actions.act_window',
            'res_model': 'hr.employee.report.summary.line',
            'res_id': self.id,
            'view_mode': 'form',
            'views': [(view_id, 'form')],
            'target': 'new',
        }

    def action_view_day_details(self):
        """Open day-wise detail lines for this employee from the report."""
        self.ensure_one()
        details = self.report_id.detail_line_ids.filtered(
            lambda d: d.employee_id.id == self.employee_id.id
        )
        view_id = self.env.ref('hr_employee_report.view_detail_line_list').id
        search_view_id = self.env.ref('hr_employee_report.view_detail_line_search').id
        return {
            'name': f'Day-wise Details – {self.employee_name}',
            'type': 'ir.actions.act_window',
            'res_model': 'hr.employee.report.detail.line',
            'view_mode': 'list',
            'views': [(view_id, 'list')],
            'search_view_id': search_view_id,
            'domain': [('id', 'in', details.ids)],
            'context': {'create': False},
            'target': 'current',
        }

    def action_view_late_records(self):
        self.ensure_one()
        report = self.report_id
        return {
            'name': f'Late Records – {self.employee_name}',
            'type': 'ir.actions.act_window',
            'res_model': 'hr.attendance',
            'view_mode': 'list,form',
            'domain': [
                ('employee_id', '=', self.employee_id.id),
                ('is_late', '=', True),
                ('late_sequence', '>', 0),
                ('date', '>=', str(report.date_from)),
                ('date', '<=', str(report.date_to)),
            ],
            'context': {'create': False},
            'target': 'current',
        }

    def action_view_leave_records(self):
        self.ensure_one()
        report = self.report_id
        return {
            'name': f'Leave Records – {self.employee_name}',
            'type': 'ir.actions.act_window',
            'res_model': 'hr.leave.request',
            'view_mode': 'list,form',
            'domain': [
                ('hr_employee_id', '=', self.employee_id.id),
                ('state', '=', 'approved'),
                ('from_date', '>=', str(report.date_from)),
                ('from_date', '<=', str(report.date_to)),
            ],
            'context': {'create': False},
            'target': 'current',
        }


# ──────────────────────────────────────────────────────────────
#  DETAIL LINE – one row per day per employee
# ──────────────────────────────────────────────────────────────
class EmployeeReportDetailLine(models.Model):
    _name = 'hr.employee.report.detail.line'
    _description = 'Employee Report Detail Line'
    _order = 'employee_name asc, entry_date asc'

    @api.model
    def _auto_init(self):
        cr = self.env.cr
        cr.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = %s AND column_name IN %s AND data_type = 'jsonb'
        """, (self._table, ('employee_name',)))
        for (col,) in cr.fetchall():
            _logger.info('Fixing column type: %s.%s from jsonb to varchar', self._table, col)
            cr.execute(
                'ALTER TABLE "' + self._table + '" DROP COLUMN "' + col + '"'
            )
        return super()._auto_init()

    report_id = fields.Many2one(
        'hr.employee.report', string='Report',
        required=True, ondelete='cascade', index=True,
    )
    currency_id = fields.Many2one(
        'res.currency', related='report_id.company_id.currency_id', readonly=True,
    )
    employee_id = fields.Many2one('hr.employee', string='Employee', readonly=True)
    employee_name = fields.Char(string='Employee', readonly=True)
    department_name = fields.Char(string='Department', readonly=True)

    entry_date = fields.Date(string='Date', readonly=True)
    day_type = fields.Selection([
        ('present', 'Present'),
        ('late', 'Late'),
        ('leave', 'Leave'),
        ('absent', 'Not Entered'),
        ('holiday', 'Holiday'),
    ], string='Day Type', readonly=True)

    description = fields.Char(string='Description', readonly=True)
    check_in_time = fields.Char(string='Check In Time', readonly=True)
    check_out_time = fields.Char(string='Check Out Time', readonly=True)
    is_half_day = fields.Boolean(string='Half Day', readonly=True)

    # Late info
    late_minutes = fields.Integer(string='Late (Min)', readonly=True)
    late_minutes_display = fields.Char(string='Late Time', readonly=True)
    late_reason = fields.Text(string='Late Reason', readonly=True)
    late_deduction = fields.Float(string='Late Deduction', readonly=True)

    # Leave info
    leave_type = fields.Selection([
        ('sick', 'Sick Leave'),
        ('casual', 'Casual Leave'),
        ('annual', 'Annual Leave'),
        ('personal', 'Personal Leave'),
        ('emergency', 'Emergency Leave'),
        ('other', 'Other'),
    ], string='Leave Type', readonly=True)
    leave_paid_type = fields.Char(string='Paid/Unpaid', readonly=True)
    leave_reason = fields.Text(string='Leave Reason', readonly=True)
    leave_deduction = fields.Float(string='Leave Deduction', readonly=True)
