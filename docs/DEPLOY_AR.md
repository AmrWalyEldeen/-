# خطوات النشر — GitHub Pages + Supabase

## 1) Supabase لمشروع جديد

- أنشئ New Project.
- SQL Editor → نفّذ `supabase/schema.sql` كاملاً.
- SQL Editor → نفّذ `supabase/seed.sql` إذا أردت تحميل بيانات البداية مباشرة.
- Authentication → Users → Add user → أنشئ Email/Password للمسؤول.
- Settings/API → انسخ Project URL و anon public key.

## 2) ترقية مشروع موجود من النسخة السابقة

- خذ Backup من الموقع أولاً.
- SQL Editor → نفّذ `supabase/migration_v2.sql` مرة واحدة.
- لا تشغّل `seed.sql` إذا كان لديك تعديلات محفوظة لا تريد فقدها.

## 3) GitHub

- أنشئ Repository جديداً.
- ارفع جميع محتويات الباكدج إلى جذر الـRepository.
- Settings → Secrets and variables → Actions:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
- Settings → Pages → Source: GitHub Actions.
- افتح تبويب Actions وانتظر نجاح Workflow باسم `Deploy GitHub Pages`.

## 4) أول دخول

إذا نفذت `seed.sql` ستظهر البيانات فوراً. إذا كانت قاعدة البيانات فارغة، سجّل دخول المسؤول ثم افتح **الإعدادات والنسخ الاحتياطي** واضغط **تحميل البيانات الأولية إلى Supabase**.

بعدها افتح تبويب **إدارة المواد والأعضاء والنصاب** لمراجعة:
- الساعات المستهدفة لكل درجة.
- نوع كل مقرر.
- طريقة احتساب الساعات.
- الأعضاء ودرجاتهم وتخصصاتهم.

## 5) الصلاحيات

الوضع الافتراضي يسمح لأي شخص لديه الرابط بالمشاهدة والطباعة، بينما التعديل يحتاج تسجيل الدخول. يمكن تقييد القراءة أيضاً بتعديل سياسات RLS داخل `schema.sql`.
