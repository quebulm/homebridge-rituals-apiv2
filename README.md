# Homebridge-Rituals-apiv2

Este proyecto es una actualización independiente basada en *homebridge-rituals* de [myluna08](https://github.com/myluna08/homebridge-rituals/tree/master).  
Ha sido adaptado para funcionar con la **API actual de Rituals (v2)** utilizando **Axios**.

> **Nota:** Este README está adaptado del proyecto original de myluna08.  
> Los cambios reflejan la migración a la API v2 y la transición a Axios.

<img src="https://img.shields.io/badge/license-MIT-green"> 

<img src="https://user-images.githubusercontent.com/19808920/58770949-bd9c7900-857f-11e9-8558-5dfaffddffda.png" height="100"> <img src="https://www.rituals.com/dw/image/v2/BBKL_PRD/on/demandware.static/-/Sites-rituals-products/default/dw7656c020/images/zoom/1106834_WirelessperfumeDiffuserPROAPrimary.png?sw=500&sh=500&sm=fit&q=100" height="100" align="right">

Homebridge-Rituals es un complemento para [Homebridge](https://github.com/nfarina/homebridge) que permite controlar un Rituals Genie a través de la infraestructura de HomeKit.

Como Siri admite dispositivos añadidos mediante HomeKit, con este plugin puedes controlar el Genie con comandos como:

- _Siri, enciende el Genie._
- _Siri, apaga el Genie._

---

### Antes de empezar (supuestos)

- Tu dispositivo Genie ya está registrado con la app oficial de Rituals.
- Tu Genie funciona correctamente.
- Tienes [Homebridge](https://github.com/nfarina/homebridge) instalado y añadido a la app "Casa". Si no, consulta la sección [Instalación desde cero](#consideraciones).

Más información en el [sitio oficial de Rituals](https://www.rituals.com/es-es/faqs.html?catid=faq-perfume-genie&qid=fag-what-is-the-perfume-genie-and-what-can-it-do).

---

## 01. Instalación

Con `npm` (instalación manual del módulo):

```sh
npm -i homebridge-rituals-apiv2
```

O busca el plugin directamente desde la interfaz UI-X de Homebridge:  
Escribe `"homebridge-rituals-apiv2"` y haz clic en **INSTALAR**.

---

## 03. Configuración en `config.json`

### ➤ Para un solo Genie

Después de instalarlo, edita tu archivo `config.json` así:

```json
"accessories": [
    {
        "accessory": "Rituals",
        "name": "Mi Genie",
        "account": "xxx@xxx.com",
        "password": "yyyyyyy"
    }
],
```

- `"account"`: correo que usaste para registrar tu dispositivo en la app de Rituals.
- `"password"`: la contraseña de tu cuenta Rituals.
- `"name"` *(opcional)*: nombre personalizado del dispositivo.

Guarda y **reinicia Homebridge**.

---

### ➤ Para múltiples Genie en una misma cuenta

1. Configura de forma estándar:

```json
"accessories": [
    {
        "accessory": "Rituals",
        "name": "Genie",
        "account": "xxx@xxx.com",
        "password": "yyyyyyy"
    }
],
```

2. Revisa el **log de Homebridge**, debería mostrar algo como:

```
[Genie] Hub NO validado.
[Genie] Se encontraron múltiples hubs en tu cuenta.
[Genie] Agrega la clave del hub correcta a tu config.json.
...
[Genie] Nombre: PrimerGenie
[Genie] Hublot: LOTXXX-XX-XXXXX-XXXXX
[Genie] Hub: f0123456789f0123456789f0123456789f0123456789f0123456789f01234567
[Genie] Clave: 0
...
```

3. Declara cada dispositivo con su identificador `"hub"`:

```json
"accessories": [
    {
        "accessory": "Rituals",
        "name": "Genie 01",
        "account": "xxx@xxx.com",
        "password": "yyyyyyy",
        "hub": "f0123456789f0123456789f0123456789f0123456789f0123456789f01234567"
    },
    {
        "accessory": "Rituals",
        "name": "Genie 02",
        "account": "xxx@xxx.com",
        "password": "yyyyyyy",
        "hub": "a0123456789a0123456789a0123456789a0123456789a0123456789a01234567"
    }
],
```

4. Reinicia Homebridge.

---

## 06. Créditos y Marcas Registradas

Este proyecto es una actualización independiente basada en el proyecto original *homebridge-rituals* de myluna08.  
**Rituals** y **Genie** son marcas registradas de *Rituals Cosmetics Enterprise B.V.*

---

## 07. Registro de Cambios (Changelog)

### 2.0.0 Cambios principales:

- Migración de la API antigua (`ocapi`, `api/account/hubs`) a la nueva API v2 (`apiv2/...`)
- Nuevo sistema de autenticación con `apiv2/account/token` y tokens Bearer
- Comunicación unificada vía Axios usando `makeAuthenticatedRequest()`
- Sistema de caché básico para evitar llamadas redundantes
- Lógica de reintento con espera progresiva si falla la autenticación
- Mejoras en manejo de errores y logs (reautenticación automática en errores 401)
- Acceso al estado del dispositivo a través de `apiv2/hubs/{hub}/attributes/{fanc,speedc}`
