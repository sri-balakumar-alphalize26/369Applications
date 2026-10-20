{
    "name": "Employee Monthly Report (Dynamic)",
    "version": "19.0.3.1.0",
    "author": "369ai",
    "category": "Human Resources",
    "summary": "Dynamic employee monthly report with day-wise attendance, late tracking, leave, deductions, H:MM format, PDF & Excel export",
    "depends": ["hr", "hr_attendance", "hr_attendance_late", "hr_leave_request", "web"],
    "data": [
        "security/ir.model.access.csv",
        "data/paper_format.xml",
        "views/employee_report_views.xml",
        "views/menu.xml",
        "reports/employee_report_pdf.xml",
    ],
    "installable": True,
    "application": False,
    "license": "LGPL-3",
}
