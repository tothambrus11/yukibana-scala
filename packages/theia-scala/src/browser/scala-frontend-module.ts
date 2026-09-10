import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { KeybindingContribution } from '@theia/core/lib/browser/keybinding';
import { ScalaEngineService } from './scala-engine-service';
import { ScalaWorkspace } from './scala-workspace';
import { ScalaRunContribution } from './scala-run-contribution';
import { ScalaLanguageContribution } from './scala-language';
import { bindScalaPreferences } from './scala-preferences';

export default new ContainerModule(bind => {
    bind(ScalaEngineService).toSelf().inSingletonScope();
    bind(ScalaWorkspace).toSelf().inSingletonScope();
    bindScalaPreferences(bind);

    bind(ScalaLanguageContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ScalaLanguageContribution);

    bind(ScalaRunContribution).toSelf().inSingletonScope();
    for (const contribution of [
        CommandContribution,
        MenuContribution,
        KeybindingContribution,
        FrontendApplicationContribution,
    ]) {
        bind(contribution).toService(ScalaRunContribution);
    }
});
