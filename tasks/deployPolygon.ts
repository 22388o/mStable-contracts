/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */
import "ts-node/register"
import "tsconfig-paths/register"
import { task, types } from "hardhat/config"
import {
    AssetProxy,
    AssetProxy__factory,
    DelayedProxyAdmin,
    DelayedProxyAdmin__factory,
    MassetManager,
    MassetManager__factory,
    Masset,
    Masset__factory,
    MockERC20,
    MockERC20__factory,
    MockInitializableToken,
    MockInitializableToken__factory,
    Nexus,
    Nexus__factory,
    PAaveIntegration,
    PAaveIntegration__factory,
    SaveWrapper,
    SaveWrapper__factory,
    SavingsContract,
    SavingsContract__factory,
    MassetLogic,
    MassetLogic__factory,
    PLiquidator,
    PLiquidator__factory,
    ERC20,
    SavingsManager__factory,
    SavingsManager,
    RewardsDistributor__factory,
    StakingRewardsWithPlatformToken__factory,
    StakingRewardsWithPlatformToken,
} from "types/generated"
import { DEAD_ADDRESS, KEY_LIQUIDATOR, KEY_PROXY_ADMIN, KEY_SAVINGS_MANAGER, ONE_DAY, ZERO_ADDRESS } from "@utils/constants"
import { BN, simpleToExactAmount } from "@utils/math"
import { formatUnits } from "@ethersproject/units"
import { MassetLibraryAddresses } from "types/generated/factories/Masset__factory"
import { Signer } from "ethers"
import { deployContract, logTxDetails } from "./utils/deploy-utils"
import { getSigner } from "./utils/signerFactory"
import { getChain, getChainAddress } from "./utils/networkAddressFactory"
import { PMTA, PmUSD, PWMATIC, tokens } from "./utils/tokens"

// FIXME: this import does not work for some reason
// import { sleep } from "@utils/time"
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const sleepTime = 10000 // milliseconds

interface Bassets {
    name: string
    symbol: string
    decimals: number
    integrator: string
    initialMint: number
}

interface DeployedBasset extends Bassets {
    bAssetContract: ERC20
    pTokenContract: ERC20
}

export const mUsdBassets: Bassets[] = [
    {
        name: "(PoS) USD Coin",
        symbol: "PoS-USDC",
        decimals: 6,
        integrator: ZERO_ADDRESS,
        initialMint: 1000000,
    },
    {
        name: "(PoS) Dai Stablecoin",
        symbol: "PoS-DAI",
        decimals: 18,
        integrator: ZERO_ADDRESS,
        initialMint: 1000000,
    },
    {
        name: "(PoS) Tether USD",
        symbol: "PoS-USDT",
        decimals: 6,
        integrator: ZERO_ADDRESS,
        initialMint: 1000000,
    },
]

const deployBasset = async (signer: Signer, name: string, symbol: string, decimals = 18, initialMint = 500000): Promise<MockERC20> => {
    const signerAddress = await signer.getAddress()
    // Deploy Implementation
    const impl = await deployContract<MockInitializableToken>(new MockInitializableToken__factory(signer), `${symbol} impl`)
    // Initialization Implementation
    const data = impl.interface.encodeFunctionData("initialize", [name, symbol, decimals, signerAddress, initialMint])
    // Deploy Proxy
    const proxy = await deployContract<AssetProxy>(new AssetProxy__factory(signer), `${symbol} proxy`, [impl.address, DEAD_ADDRESS, data])

    return new MockERC20__factory(signer).attach(proxy.address)
}

const deployBassets = async (signer: Signer, bAssetsProps: Bassets[]): Promise<DeployedBasset[]> => {
    const signerAddress = await signer.getAddress()
    const bAssets: DeployedBasset[] = []
    let i = 0
    // eslint-disable-next-line
    for (const basset of bAssetsProps) {
        const bAssetContract = await deployBasset(signer, basset.name, basset.symbol, basset.decimals, basset.initialMint)

        await sleep(sleepTime)

        const pTokenContract = await deployContract<MockERC20>(new MockERC20__factory(signer), `pToken for ${basset.symbol}`, [
            `Aave Matic Market ${basset.name}`,
            `am${basset.symbol}`,
            basset.decimals,
            signerAddress,
            0,
        ])
        bAssets.push({
            ...bAssetsProps[i],
            bAssetContract,
            pTokenContract,
        })
        i += 1
    }
    return bAssets
}

const attachBassets = (
    deployer: Signer,
    bAssetsProps: Bassets[],
    bAssetAddresses: string[],
    pTokenAddresses: string[],
): DeployedBasset[] => {
    const bAssets: DeployedBasset[] = []
    bAssetsProps.forEach((basset, i) => {
        const bAssetContract = new MockERC20__factory(deployer).attach(bAssetAddresses[i])
        const pTokenContract = new MockERC20__factory(deployer).attach(pTokenAddresses[i])
        bAssets.push({
            ...bAssetsProps[i],
            bAssetContract,
            pTokenContract,
        })
    })
    return bAssets
}

const deployMasset = async (
    deployer: Signer,
    linkedAddress: MassetLibraryAddresses,
    nexus: Nexus,
    delayedProxyAdmin: DelayedProxyAdmin,
    recolFee = simpleToExactAmount(5, 13),
): Promise<Masset> => {
    const mAssetFactory = new Masset__factory(linkedAddress, deployer)
    const impl = await deployContract<Masset>(mAssetFactory, "Masset Impl", [nexus.address, recolFee])
    const proxy = await deployContract<AssetProxy>(new AssetProxy__factory(deployer), "Masset Proxy", [
        impl.address,
        delayedProxyAdmin.address,
        "0x", // Passing zero bytes as we'll initialize the proxy contract later
    ])
    return mAssetFactory.attach(proxy.address)
}

const deployInterestBearingMasset = async (
    deployer: Signer,
    nexus: Nexus,
    mUsd: Masset,
    delayedProxyAdmin: DelayedProxyAdmin,
    poker: string,
    symbol: string,
    name: string,
): Promise<SavingsContract> => {
    const impl = await deployContract<SavingsContract>(new SavingsContract__factory(deployer), "SavingsContract Impl", [
        nexus.address,
        mUsd.address,
    ])
    const initializeData = impl.interface.encodeFunctionData("initialize", [poker, name, symbol])
    const proxy = await deployContract<AssetProxy>(new AssetProxy__factory(deployer), "SavingsContract Proxy", [
        impl.address,
        delayedProxyAdmin.address,
        initializeData,
    ])

    return new SavingsContract__factory(deployer).attach(proxy.address)
}

const deployAaveIntegration = async (
    deployer: Signer,
    nexus: Nexus,
    mAsset: Masset,
    bAssetAddresses: string[],
    pTokenAddresses: string[],
    networkName: string,
): Promise<{ integrator: PAaveIntegration; liquidator: PLiquidator }> => {
    let platformAddress = DEAD_ADDRESS
    let rewardTokenAddress = DEAD_ADDRESS
    let rewardControllerAddress = DEAD_ADDRESS
    let quickSwapRouter = DEAD_ADDRESS

    if (networkName === "polygon_mainnet") {
        platformAddress = "0xd05e3E715d945B59290df0ae8eF85c1BdB684744" // Aave lendingPoolAddressProvider
        rewardTokenAddress = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" // wMatic
        rewardControllerAddress = "0x357D51124f59836DeD84c8a1730D72B749d8BC23" // Aave AaveIncentivesController
        quickSwapRouter = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
    }

    const aaveIntegration = await deployContract<PAaveIntegration>(new PAaveIntegration__factory(deployer), "PAaveIntegration", [
        nexus.address,
        mAsset.address,
        platformAddress,
        rewardTokenAddress,
        rewardControllerAddress,
    ])
    // initialize Aave integration with bAssets and pTokens
    console.log(`About to initialize Aave integration with bAssets ${bAssetAddresses} and pTokens ${pTokenAddresses}`)
    const tx = await aaveIntegration.initialize(bAssetAddresses, pTokenAddresses)
    await tx.wait()

    // Deploy Liquidator
    const liquidator = await deployContract<PLiquidator>(new PLiquidator__factory(deployer), "PLiquidator", [
        nexus.address,
        quickSwapRouter,
        mAsset.address,
    ])

    return {
        integrator: aaveIntegration,
        liquidator,
    }
}

const mint = async (sender: Signer, bAssets: DeployedBasset[], mAsset: Masset, scaledMintQty: BN) => {
    const senderAddress = await sender.getAddress()
    // Approve spending
    const approvals: BN[] = []
    // eslint-disable-next-line
    for (const bAsset of bAssets) {
        const dec = bAsset.decimals
        const approval = dec === 18 ? scaledMintQty : scaledMintQty.div(simpleToExactAmount(1, BN.from(18).sub(dec)))
        approvals.push(approval)
        const tx = await bAsset.bAssetContract.approve(mAsset.address, approval)
        const receiptApprove = await tx.wait()
        console.log(
            `Approved mAsset to transfer ${formatUnits(scaledMintQty)} ${bAsset.symbol} from ${senderAddress}. gas used ${
                receiptApprove.gasUsed
            }`,
        )
        console.log(`Balance ${(await bAsset.bAssetContract.balanceOf(await sender.getAddress())).toString()}`)
    }

    // Mint
    const tx = await mAsset.mintMulti(
        bAssets.map((b) => b.bAssetContract.address),
        approvals,
        1,
        await sender.getAddress(),
        { gasLimit: 8000000 },
    )
    const receiptMint = await tx.wait()

    // Log minted amount
    const mAssetAmount = formatUnits(await mAsset.totalSupply())
    console.log(`Minted ${mAssetAmount} mAssets from ${formatUnits(scaledMintQty)} units for each bAsset. gas used ${receiptMint.gasUsed}`)
}

const save = async (sender: Signer, mAsset: Masset, imAsset: SavingsContract, scaledSaveQty: BN) => {
    console.log(`About to save ${formatUnits(scaledSaveQty)} mAssets`)
    await mAsset.approve(imAsset.address, scaledSaveQty)
    await imAsset["depositSavings(uint256)"](scaledSaveQty, { gasLimit: 8000000 })
    console.log(`Saved ${formatUnits(scaledSaveQty)} mAssets to interest bearing mAssets`)
}

task("deploy-polly", "Deploys mUSD & System to a Polygon network")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const { network } = hre
        const signer = await getSigner(hre, taskArgs.speed)
        const signerAddress = await signer.getAddress()

        // Deploy Nexus
        const nexus = await deployContract<Nexus>(new Nexus__factory(signer), "Nexus", [signerAddress])

        // Deploy DelayedProxyAdmin
        const delayedProxyAdmin = await deployContract<DelayedProxyAdmin>(new DelayedProxyAdmin__factory(signer), "DelayedProxyAdmin", [
            nexus.address,
        ])

        await sleep(sleepTime)

        let deployedUsdBassets: DeployedBasset[]
        let multiSigAddress: string
        if (network.name === "hardhat") {
            multiSigAddress = signerAddress
            // Deploy mocked base USD assets
            deployedUsdBassets = await deployBassets(signer, mUsdBassets)
        } else if (network.name === "polygon_testnet") {
            multiSigAddress = "0xE1304aA964C5119C98E8AE554F031Bf3B21eC836" // 1/3 Multisig
            // Attach to already deployed mocked bAssets
            deployedUsdBassets = attachBassets(
                signer,
                mUsdBassets,
                [
                    "0x4fa81E591dC5dAf1CDA8f21e811BAEc584831673", // USDC
                    "0xD84574BFE3294b472C74D7a7e3d3bB2E92894B48", // DAI
                    "0x872093ee2BCb9951b1034a4AAC7f489215EDa7C2", // Tether
                ],
                [
                    "0xA2De18B8AE0450D918EA5Bf5890CBA5dD7055A4f",
                    "0x85581E4BDeDB67840876DF20eFeaA6926dfFa11E",
                    "0xAD209ADbCDF8B6917E69E6BcF9D05592388B8ada",
                ],
            )
        } else if (network.name === "polygon_mainnet") {
            multiSigAddress = "0x4aA2Dd5D5387E4b8dcf9b6Bfa4D9236038c3AD43" // 4/8 Multisig
            // Attach to 3rd party bAssets
            deployedUsdBassets = attachBassets(
                signer,
                mUsdBassets,
                [
                    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
                    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
                    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // Tether
                ],
                [
                    "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F",
                    "0x27F8D03b3a2196956ED754baDc28D73be8830A6e",
                    "0x60D55F02A771d515e077c9C2403a1ef324885CeC",
                ],
            )
        }

        await sleep(sleepTime)

        // Deploy mAsset dependencies
        const massetLogic = await deployContract<MassetLogic>(new MassetLogic__factory(signer), "MassetLogic")
        const managerLib = await deployContract<MassetManager>(new MassetManager__factory(signer), "MassetManager")
        const linkedAddress = {
            "contracts/masset/MassetLogic.sol:MassetLogic": massetLogic.address,
            "contracts/masset/MassetManager.sol:MassetManager": managerLib.address,
        }

        // Deploy mUSD Masset
        const mUsd = await deployMasset(signer, linkedAddress, nexus, delayedProxyAdmin)

        await sleep(sleepTime)

        const { integrator, liquidator } = await deployAaveIntegration(
            signer,
            nexus,
            mUsd,
            deployedUsdBassets.map((b) => b.bAssetContract.address),
            deployedUsdBassets.map((b) => b.pTokenContract.address),
            network.name,
        )

        const config = {
            a: 300,
            limits: {
                min: simpleToExactAmount(5, 16),
                max: simpleToExactAmount(75, 16),
            },
        }
        const txMusd = await mUsd.initialize(
            "mUSD",
            "mStable USD (Polygon PoS)",
            deployedUsdBassets.map((b) => ({
                addr: b.bAssetContract.address,
                integrator: network.name === "polygon_mainnet" ? integrator.address : ZERO_ADDRESS,
                hasTxFee: false,
                status: 0,
            })),
            config,
            { gasLimit: 8000000 },
        )
        console.log(`mUSD initialize tx ${txMusd.hash}`)
        const receiptMusd = await txMusd.wait()
        console.log(`mUSD initialize status ${receiptMusd.status} from receipt`)

        await sleep(sleepTime)

        // Deploy Interest Bearing mUSD
        const imUsd = await deployInterestBearingMasset(
            signer,
            nexus,
            mUsd,
            delayedProxyAdmin,
            DEAD_ADDRESS,
            "imUSD",
            "Interest bearing mStable USD (Polygon PoS)",
        )

        await sleep(sleepTime)

        // Deploy Save Wrapper
        const saveWrapper = await deployContract<SaveWrapper>(new SaveWrapper__factory(signer), "SaveWrapper")

        // Deploy Savings Manager
        const savingsManager = await deployContract<SavingsManager>(new SavingsManager__factory(signer), "SavingsManager", [
            nexus.address,
            mUsd.address,
            imUsd.address,
            simpleToExactAmount(9, 17), // 90% = 9e17
            ONE_DAY,
        ])

        await sleep(sleepTime)

        // SaveWrapper contract approves the savings contract (imUSD) to spend its USD mAsset tokens (mUSD)
        await saveWrapper["approve(address,address)"](mUsd.address, imUsd.address)
        // SaveWrapper approves the mUSD contract to spend its bAsset tokens
        const bAssetAddresses = deployedUsdBassets.map((b) => b.bAssetContract.address)
        await saveWrapper["approve(address[],address)"](bAssetAddresses, mUsd.address)
        console.log("Successful token approvals from the SaveWrapper")

        await sleep(sleepTime)

        // Initialize Nexus Modules
        const moduleKeys = [KEY_SAVINGS_MANAGER, KEY_PROXY_ADMIN, KEY_LIQUIDATOR]
        const moduleAddresses = [savingsManager.address, delayedProxyAdmin.address, liquidator.address]
        const moduleIsLocked = [false, true, false]
        const nexusTx = await nexus.connect(signer).initialize(moduleKeys, moduleAddresses, moduleIsLocked, multiSigAddress)
        const nexusReceipt = await nexusTx.wait()
        console.log(`Nexus initialize status ${nexusReceipt.status} from receipt`)

        await sleep(sleepTime)

        if (hre.network.name !== "polygon_mainnet") {
            await mint(signer, deployedUsdBassets, mUsd, simpleToExactAmount(20))
            await save(signer, mUsd, imUsd, simpleToExactAmount(15))
        } else if (hre.network.name === "polygon_mainnet") {
            // Multimint 2 USD and then save 4
            await mint(signer, deployedUsdBassets, mUsd, simpleToExactAmount(2))
            await save(signer, mUsd, imUsd, simpleToExactAmount(4))
        }
    })

task("liquidator-snap", "Dumps the config details of the liquidator on Polygon")
    .addParam("asset", "Symbol of asset to get liquidation details for. eg USDC, PUSDC, DAI, GUSD, alUSD", undefined, types.string)
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const asset = tokens.find((t) => t.symbol === taskArgs.asset && t.chain === chain)
        if (!asset) throw Error(`Could not find asset with symbol ${taskArgs.asset}`)

        const liquidatorAddress = getChainAddress("Liquidator", chain)
        const liquidator = PLiquidator__factory.connect(liquidatorAddress, signer)

        const liquidationConfig = await liquidator.liquidations(asset.integrator)
        console.log(liquidationConfig)
    })

task("deploy-vimusd", "Deploy Polygon imUSD staking contract v-imUSD")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const fundManagerAddress = getChainAddress("FundManager", chain)
        const governorAddress = getChainAddress("Governor", chain)
        const nexusAddress = getChainAddress("Nexus", chain)
        const rewardsDistributorAddress = getChainAddress("RewardsDistributor", chain)

        const rewardsDistributor = rewardsDistributorAddress
            ? RewardsDistributor__factory.connect(rewardsDistributorAddress, signer)
            : await deployContract(new RewardsDistributor__factory(signer), "RewardsDistributor", [
                  nexusAddress,
                  [fundManagerAddress, governorAddress],
              ])

        const stakingRewardsImpl = await deployContract(
            new StakingRewardsWithPlatformToken__factory(signer),
            "StakingRewardsWithPlatformToken",
            [
                nexusAddress,
                PmUSD.savings, // imUSD
                PMTA.address, // MTA bridged to Polygon
                PWMATIC.address, // Wrapped Matic on Polygon
                ONE_DAY.mul(7), // 7 days
            ],
        )
        const initializeData = stakingRewardsImpl.interface.encodeFunctionData("initialize", [
            rewardsDistributor.address,
            "imUSD Vault",
            "v-imUSD",
        ])
        const proxy = await deployContract(new AssetProxy__factory(signer), "Staking Rewards Proxy", [
            stakingRewardsImpl.address,
            governorAddress,
            initializeData,
        ])
        const stakingRewards = StakingRewardsWithPlatformToken__factory.connect(proxy.address, signer)

        console.log(`Name                ${await stakingRewards.name()}`)
        console.log(`Symbol              ${await stakingRewards.symbol()}`)
        console.log(`Duration            ${await stakingRewards.DURATION()}`)
        console.log(`Nexus               ${await stakingRewards.nexus()}`)
        console.log(`Staking token       ${await stakingRewards.stakingToken()}`)
        console.log(`Rewards token       ${await stakingRewards.rewardsToken()}`)
        console.log(`Platform token      ${await stakingRewards.platformToken()}`)
        console.log(`Rewards distributor ${await stakingRewards.rewardsDistributor()}`)
    })

task("upgrade-vimusd", "Upgrade Polygon imUSD staking contract v-imUSD")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)
        const chain = getChain(hre)

        const nexusAddress = getChainAddress("Nexus", chain)
        const rewardsDistributorAddress = getChainAddress("RewardsDistributor", chain)

        const rewardsDistributor = RewardsDistributor__factory.connect(rewardsDistributorAddress, signer)

        const stakingRewardsImpl = await deployContract<StakingRewardsWithPlatformToken>(
            new StakingRewardsWithPlatformToken__factory(signer),
            "StakingRewardsWithPlatformToken (v-imUSD)",
            [
                nexusAddress,
                PmUSD.savings, // imUSD
                PMTA.address, // MTA bridged to Polygon
                PWMATIC.address, // Wrapped Matic on Polygon
                ONE_DAY.mul(91), // 3 months
            ],
        )
        const initializeData = stakingRewardsImpl.interface.encodeFunctionData("initialize", [
            rewardsDistributor.address,
            "imUSD Vault",
            "v-imUSD",
        ])
        console.log(`Initialize Staking Rewards:\n${initializeData}`)

        const proxy = AssetProxy__factory.connect(PmUSD.vault, signer)
        const upgradeData = proxy.interface.encodeFunctionData("upgradeToAndCall", [stakingRewardsImpl.address, initializeData])
        console.log(`\nupgradeToAndCall data:\n${upgradeData}`)
    })

task("exit-vimusd", "Upgrade Polygon imUSD staking contract v-imUSD")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .setAction(async (taskArgs, hre) => {
        const signer = await getSigner(hre, taskArgs.speed)

        const vimusd = StakingRewardsWithPlatformToken__factory.connect(PmUSD.vault, signer)

        const tx = await vimusd.exit()
        await logTxDetails(tx, "exit from v-imUSD")
    })

module.exports = {}
